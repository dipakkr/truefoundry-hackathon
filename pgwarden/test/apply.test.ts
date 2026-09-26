import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sqlSha256 } from "../src/audit.js";
import { createMasker } from "../src/mask.js";
import { checkPolicy } from "../src/policy.js";
import { buildServer } from "../src/tools.js";
import { CORRECT_FIX, createPool, dropDb, DUPES, freshDb, ORDERS, ORIGINAL_PR_SQL, seedMiniProd, UNIQUE_USERS, type Pool } from "./helpers.js";

const DB = "pgwarden_test_apply";
const GOOD_EFFECTS = { row_deltas: { users: -DUPES, orders: 0 }, schema_changes: ["+column:users.mobile", "+index:users.users_email_lower_uniq"] };
const REPORT = { version: 1, verdict: "pass" };

describe("policy pre-check", () => {
  const refused = async (sql: string, re: RegExp) => {
    const p = await checkPolicy(sql);
    assert.equal(p.ok, false, sql);
    assert.ok(p.violations.some((v) => re.test(v)), `${sql} -> ${p.violations}`);
  };
  test("contract list is refused", async () => {
    await refused("DROP TABLE orders;", /DROP TABLE/);
    await refused("TRUNCATE orders;", /TRUNCATE/);
    await refused("DROP SCHEMA public CASCADE;", /DROP SCHEMA/);
    await refused("DROP DATABASE shopkart;", /DROP DATABASE/);
    await refused("ALTER TABLE users ADD COLUMN a text, DROP COLUMN phone;", /DROP COLUMN/);
    await refused("ALTER TABLE users RENAME COLUMN phone TO mobile;", /RENAME COLUMN/);
    await refused("ALTER TABLE users RENAME TO customers;", /RENAME TO/);
    await refused("DELETE FROM users;", /DELETE without WHERE/);
    await refused("WITH d AS (DELETE FROM users RETURNING id) SELECT count(*) FROM d;", /DELETE without WHERE/);
    await refused("GRANT ALL ON users TO public;", /GRANT/);
    await refused("REVOKE ALL ON users FROM public;", /REVOKE/);
    await refused("ALTER ROLE postgres NOSUPERUSER;", /ROLE/);
    await refused(Array.from({ length: 21 }, (_, i) => `SELECT ${i};`).join("\n"), /21 statements/);
  });
  test("things that would escape the guarded transaction are refused", async () => {
    await refused("COMMIT; DROP INDEX x;", /transaction control/);
    await refused("SET statement_timeout = 0;", /SET/);
    await refused("DO $$ BEGIN EXECUTE 'DROP TABLE orders'; END $$;", /DO block/);
    await refused("this is not sql;", /does not parse/);
  });
  test("the reference fix passes (UPDATE without WHERE ok, DELETE ... USING ... WHERE ok, CTE ok)", async () => {
    const p = await checkPolicy(CORRECT_FIX);
    assert.deepEqual(p, { ok: true, statements: 5, violations: [] });
  });
  test("semicolons in strings/comments/dollar quotes don't split statements", async () => {
    const p = await checkPolicy("-- a; DROP TABLE x;\nCOMMENT ON TABLE users IS 'a; DROP TABLE orders;'; SELECT $q$;DROP TABLE y;$q$;");
    assert.deepEqual(p, { ok: true, statements: 2, violations: [] });
  });
});

describe("apply_migration refusal table (WS1 T6) through the MCP tool", () => {
  let pool: Pool;
  let client: Client;
  const logs: string[] = [];

  async function call(name: string, args: Record<string, unknown>) {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
  }
  const state = async () => (await call("verify_prod_state", {})).body;
  const rehearse = async (sql: string, verdict = "pass") => (await call("record_rehearsal", { sql, verdict, report: REPORT })).body.rehearsal_id as string;
  const apply = (sql: string, rehearsal_id: string, declared_effects = GOOD_EFFECTS) =>
    call("apply_migration", { sql, rehearsal_id, declared_effects, evidence_summary: "rehearsed on a masked full copy" });
  async function auditRows() {
    return (await pool.query("SELECT count(*)::int n FROM pgwarden.audit_log")).rows[0].n as number;
  }

  before(async () => {
    pool = createPool(await freshDb(DB));
    await seedMiniProd(pool);
    const server = buildServer({ pool, masker: createMasker("k"), log: (l) => logs.push(l) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "test", version: "0" });
    await client.connect(b);
  });
  after(async () => {
    await client.close();
    await pool.end();
    await dropDb(DB);
  });

  test("baseline", async () => {
    const s = await state();
    assert.deepEqual(s.row_counts, { orders: ORDERS, users: UNIQUE_USERS + DUPES });
    assert.equal(s.last_applied_version, "0006");
    assert.equal(s.has_index_users_email_lower_uniq, false);
    assert.deepEqual(s.columns_users, ["id", "email", "full_name", "phone", "city", "created_at"]);
  });

  test("record_rehearsal hashes sql.trim()", async () => {
    const r = await call("record_rehearsal", { sql: CORRECT_FIX, verdict: "pass", report: REPORT });
    assert.equal(r.isError, false);
    assert.match(r.body.rehearsal_id, /^rh_[a-z0-9]{6}$/);
    assert.equal(r.body.sql_sha256, createHash("sha256").update(CORRECT_FIX.trim()).digest("hex"));
    assert.equal(sqlSha256(`\n  ${CORRECT_FIX}\n\n`), r.body.sql_sha256, "only surrounding whitespace is trimmed");
    assert.ok(!Number.isNaN(Date.parse(r.body.recorded_at)));
  });

  test("DROP TABLE orders (the injection) -> POLICY_REFUSED before any DB work", async () => {
    const before = await state();
    const rid = await rehearse("DROP TABLE orders;"); // even with a 'passing' rehearsal on record
    const r = await apply("DROP TABLE orders;", rid, { row_deltas: { orders: -ORDERS, users: 0 }, schema_changes: ["-table:orders"] });
    assert.equal(r.isError, true);
    assert.equal(r.body.code, "POLICY_REFUSED");
    assert.match(r.body.message, /DROP TABLE/);
    assert.deepEqual(await state(), before);
  });

  test("original PR SQL (RENAME COLUMN) -> POLICY_REFUSED", async () => {
    const rid = await rehearse(ORIGINAL_PR_SQL);
    const r = await apply(ORIGINAL_PR_SQL, rid, { row_deltas: { users: 0, orders: 0 }, schema_changes: ["+column:users.mobile", "-column:users.phone", "+index:users.users_email_lower_uniq"] });
    assert.equal(r.body.code, "POLICY_REFUSED");
    assert.match(r.body.message, /RENAME COLUMN/);
  });

  test("correct fix, declared users -13 -> EFFECTS_MISMATCH, rolled back, prod unchanged", async () => {
    const before = await state();
    const rid = await rehearse(CORRECT_FIX);
    const r = await apply(CORRECT_FIX, rid, { ...GOOD_EFFECTS, row_deltas: { users: -13, orders: 0 } });
    assert.equal(r.body.code, "EFFECTS_MISMATCH");
    assert.deepEqual(r.body.detail.actual, { row_deltas: { orders: 0, users: -DUPES }, schema_changes: GOOD_EFFECTS.schema_changes });
    assert.deepEqual(r.body.detail.declared.row_deltas, { users: -13, orders: 0 });
    assert.deepEqual(await state(), before);
    const owned = (await pool.query("SELECT count(*)::int n FROM orders WHERE user_id > $1", [UNIQUE_USERS])).rows[0].n;
    assert.equal(owned, 25, "the UPDATE of orders was rolled back too");
  });

  test("SQL one char different from the rehearsed SQL -> REHEARSAL_MISMATCH", async () => {
    const rid = await rehearse(CORRECT_FIX);
    const r = await apply(CORRECT_FIX.replace("-- 1.", "-- 2."), rid); // one char, even inside a comment
    assert.equal(r.body.code, "REHEARSAL_MISMATCH");
    const r2 = await apply(CORRECT_FIX.replace("keep_id", "keep_iD"), rid);
    assert.equal(r2.body.code, "REHEARSAL_MISMATCH");
  });

  test("unknown / failed / stale rehearsals are refused", async () => {
    assert.equal((await apply(CORRECT_FIX, "rh_nope00")).body.code, "REHEARSAL_NOT_FOUND");
    assert.equal((await apply(CORRECT_FIX, await rehearse(CORRECT_FIX, "fail"))).body.code, "REHEARSAL_FAILED");
    const stale = await rehearse(CORRECT_FIX);
    await pool.query("UPDATE pgwarden.rehearsals SET created_at = now() - interval '31 minutes' WHERE id = $1", [stale]);
    assert.equal((await apply(CORRECT_FIX, stale)).body.code, "REHEARSAL_STALE");
  });

  test("SQL error -> SQL_ERROR with the Postgres message, rolled back", async () => {
    const sql = "ALTER TABLE users ADD COLUMN mobile text;\nCREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));";
    const before = await state();
    const r = await apply(sql, await rehearse(sql), { row_deltas: { users: 0, orders: 0 }, schema_changes: GOOD_EFFECTS.schema_changes });
    assert.equal(r.body.code, "SQL_ERROR");
    assert.match(r.body.message, /could not create unique index "users_email_lower_uniq"/);
    assert.deepEqual(await state(), before, "the ADD COLUMN was rolled back");
  });

  let committedId = "";
  test("correct fix + correct declaration -> committed", async () => {
    committedId = await rehearse(CORRECT_FIX);
    const r = await apply(`\n${CORRECT_FIX}\n\n`, committedId, { row_deltas: { orders: 0, users: -DUPES }, schema_changes: [...GOOD_EFFECTS.schema_changes].reverse() });
    assert.equal(r.isError, false, JSON.stringify(r.body));
    assert.equal(r.body.status, "committed");
    assert.equal(r.body.applied_version, "0007");
    assert.deepEqual(r.body.actual_effects, { row_deltas: { orders: 0, users: -DUPES }, schema_changes: GOOD_EFFECTS.schema_changes });
    assert.equal(typeof r.body.duration_ms, "number");
    const s = await state();
    assert.deepEqual(s.row_counts, { orders: ORDERS, users: UNIQUE_USERS });
    assert.equal(s.has_index_users_email_lower_uniq, true);
    assert.deepEqual(s.columns_users, ["id", "email", "full_name", "phone", "city", "created_at", "mobile"]);
    assert.equal(s.last_applied_version, "0007");
    const orphans = (await pool.query("SELECT count(*)::int n FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE u.id IS NULL")).rows[0].n;
    assert.equal(orphans, 0);
  });

  test("apply the same rehearsal twice -> ALREADY_APPLIED (and same SQL under a new rehearsal too)", async () => {
    const before = await state();
    assert.equal((await apply(CORRECT_FIX, committedId)).body.code, "ALREADY_APPLIED");
    assert.equal((await apply(CORRECT_FIX, await rehearse(CORRECT_FIX))).body.code, "ALREADY_APPLIED");
    assert.deepEqual(await state(), before);
  });

  test("every call was audited and logged without SQL or secrets", async () => {
    assert.ok((await auditRows()) >= 10);
    const outcomes = (await pool.query("SELECT outcome FROM pgwarden.audit_log WHERE tool = 'apply_migration'")).rows.map((r: any) => r.outcome);
    for (const code of ["POLICY_REFUSED", "EFFECTS_MISMATCH", "REHEARSAL_MISMATCH", "REHEARSAL_NOT_FOUND", "REHEARSAL_FAILED", "REHEARSAL_STALE", "SQL_ERROR", "committed", "ALREADY_APPLIED"])
      assert.ok(outcomes.includes(code), code);
    assert.ok(logs.some((l) => /tool=apply_migration ms=\d+ outcome=committed:0007/.test(l)));
    assert.ok(logs.every((l) => !/DROP|UPDATE|lower\(/.test(l)));
  });
});

describe("protected tables are append-only, even with approval", () => {
  let pool: Pool;
  let client: Client;
  const DB2 = "pgwarden_test_protect";
  async function call(name: string, args: Record<string, unknown>) {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
  }
  before(async () => {
    pool = createPool(await freshDb(DB2));
    await seedMiniProd(pool);
    const server = buildServer({ pool, masker: createMasker("k"), log: () => {}, protectedTables: ["users"] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "t", version: "1" });
    await client.connect(b);
  });
  after(async () => {
    await client.close();
    await pool.end();
    await dropDb(DB2);
  });
  test("a fix that deletes users rows -> PROTECTED_ROWS_LOST, rolled back, prod unchanged", async () => {
    const before = (await call("verify_prod_state", {})).body;
    const rid = (await call("record_rehearsal", { sql: CORRECT_FIX, verdict: "pass", report: REPORT })).body.rehearsal_id;
    const r = await call("apply_migration", { sql: CORRECT_FIX, rehearsal_id: rid, declared_effects: GOOD_EFFECTS, evidence_summary: "declared honestly" });
    assert.equal(r.body.code, "PROTECTED_ROWS_LOST");
    assert.deepEqual(r.body.detail.lost, { users: -DUPES });
    assert.deepEqual((await call("verify_prod_state", {})).body, before);
  });
});
