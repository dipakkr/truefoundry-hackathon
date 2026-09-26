import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { analyzeMigration } from "../src/analyze.js";
import { APPLY_LOCK_KEY, applyMigration } from "../src/apply.js";
import { recordRehearsal } from "../src/audit.js";
import { withReadOnly } from "../src/db.js";
import { ToolError, verifyProdState } from "../src/schema.js";
import { CORRECT_FIX, createPool, dbUrl, dropDb, DUPES, freshDb, ORDERS, ORIGINAL_PR_SQL, seedMiniProd, UNIQUE_USERS, type Pool } from "./helpers.js";

const GOOD_EFFECTS = { row_deltas: { users: -DUPES, orders: 0 }, schema_changes: ["+column:users.mobile", "+index:users.users_email_lower_uniq"] };
const REPORT = { version: 1, verdict: "pass" };

const state = (pool: Pool) => withReadOnly(pool, verifyProdState);
const rehearse = async (pool: Pool, sql: string) => (await recordRehearsal(pool, sql, "pass", REPORT)).rehearsal_id;
/** applyMigration, returning either the committed result or the refusal {code, detail}. */
async function apply(pool: Pool, sql: string, rehearsal_id: string, declared_effects = GOOD_EFFECTS, opts = {}) {
  try {
    return { ok: true as const, ...(await applyMigration(pool, { sql, rehearsal_id, declared_effects, evidence_summary: "test" }, opts)) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false as const, code: e.code, message: e.message, detail: e.detail as any };
    throw e;
  }
}
const backupTables = async (pool: Pool) =>
  (await pool.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pgwarden' AND c.relname LIKE 'bk\\_%' ORDER BY 1`)).rows.map((r: any) => r.relname as string);

describe("drift detection (DRIFT_DETECTED)", () => {
  const DB = "pgwarden_test_drift";
  let pool: Pool;
  before(async () => {
    pool = createPool(await freshDb(DB));
    await seedMiniProd(pool);
  });
  after(async () => {
    await pool.end();
    await dropDb(DB);
  });

  test("record_rehearsal returns prod_fingerprint = verify_prod_state's schema_fingerprint", async () => {
    const r = await recordRehearsal(pool, CORRECT_FIX, "pass", REPORT);
    assert.equal(r.prod_fingerprint, (await state(pool)).schema_fingerprint);
    const row = (await pool.query("SELECT prod_fingerprint FROM pgwarden.rehearsals WHERE id = $1", [r.rehearsal_id])).rows[0];
    assert.equal(row.prod_fingerprint, r.prod_fingerprint);
  });

  test("schema changed after the rehearsal -> DRIFT_DETECTED, prod unchanged, no backup", async () => {
    const rid = await rehearse(pool, CORRECT_FIX);
    const rehearsedFp = (await state(pool)).schema_fingerprint;
    await pool.query("ALTER TABLE users ADD COLUMN x int");
    const before = await state(pool);
    const r = await apply(pool, CORRECT_FIX, rid);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, "DRIFT_DETECTED");
    assert.ok(r.ok === false && /schema changed since rehearsal .* Rehearse again/.test(r.message));
    assert.deepEqual(r.ok === false && r.detail, { rehearsed_fingerprint: rehearsedFp, current_fingerprint: before.schema_fingerprint });
    assert.deepEqual(await state(pool), before, "prod unchanged");
    assert.deepEqual(await backupTables(pool), []);
    const audit = (await pool.query("SELECT count(*)::int n FROM pgwarden.audit_log WHERE outcome = 'DRIFT_DETECTED'")).rows[0].n;
    assert.equal(audit, 1);
  });

  test("a rehearsal recorded before drift detection existed (NULL fingerprint) skips the check", async () => {
    const rid = await rehearse(pool, CORRECT_FIX);
    await pool.query("UPDATE pgwarden.rehearsals SET prod_fingerprint = NULL WHERE id = $1", [rid]);
    await pool.query("ALTER TABLE users DROP COLUMN x"); // prod differs from the recorded (now NULL) state anyway
    await pool.query("ALTER TABLE users ADD COLUMN y int");
    const r = await apply(pool, CORRECT_FIX, rid);
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("audit schema upgrade: an old rehearsals table without prod_fingerprint gets the column", async () => {
    await pool.query("ALTER TABLE pgwarden.rehearsals DROP COLUMN prod_fingerprint");
    const r = await recordRehearsal(pool, "SELECT 1;", "pass", REPORT);
    assert.match(r.prod_fingerprint, /^[0-9a-f]{64}$/);
  });
});

describe("data drift, deploy lock, pre-apply backup", () => {
  const DB = "pgwarden_test_guard";
  let pool: Pool;
  before(async () => {
    pool = createPool(await freshDb(DB));
    await seedMiniProd(pool);
  });
  after(async () => {
    await pool.end();
    await dropDb(DB);
  });

  test("data drift: one more case-variant duplicate after a passing rehearsal -> EFFECTS_MISMATCH, rolled back, no backup kept", async () => {
    const rid = await rehearse(pool, CORRECT_FIX);
    await pool.query(
      `INSERT INTO users (email, full_name, phone, city, created_at)
       SELECT lower(email), full_name, phone, city, '2026-06-01T00:00:00Z' FROM users WHERE id = 2`,
    );
    const before = await state(pool);
    const r = await apply(pool, CORRECT_FIX, rid); // the originally true effects (users -14)
    assert.equal(r.ok === false && r.code, "EFFECTS_MISMATCH");
    assert.deepEqual(r.ok === false && r.detail.actual.row_deltas, { orders: 0, users: -(DUPES + 1) });
    assert.deepEqual(await state(pool), before, "rolled back");
    assert.deepEqual(await backupTables(pool), [], "the backup made inside the transaction was rolled back too");
    await pool.query("DELETE FROM users WHERE id > $1", [UNIQUE_USERS + DUPES]);
  });

  test("another apply holds the deploy lock -> APPLY_IN_PROGRESS, prod unchanged", async () => {
    const holder = new pg.Client({ connectionString: dbUrl(DB) });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [APPLY_LOCK_KEY]);
      const before = await state(pool);
      const r = await apply(pool, CORRECT_FIX, await rehearse(pool, CORRECT_FIX));
      assert.equal(r.ok === false && r.code, "APPLY_IN_PROGRESS");
      assert.match(r.ok === false ? r.message : "", /another migration is being applied/i);
      assert.deepEqual(await state(pool), before);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1::bigint)", [APPLY_LOCK_KEY]);
      await holder.end();
    }
  });

  let committed: any;
  test("two simultaneous applies (two rehearsals of the same SQL) -> exactly one commit, no deadlock", async () => {
    const [r1, r2] = [await rehearse(pool, CORRECT_FIX), await rehearse(pool, CORRECT_FIX)];
    const results = await Promise.all([apply(pool, CORRECT_FIX, r1), apply(pool, CORRECT_FIX, r2)]);
    const ok = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok) as { code: string }[];
    assert.equal(ok.length, 1, JSON.stringify(results));
    assert.ok(["APPLY_IN_PROGRESS", "ALREADY_APPLIED"].includes(refused[0].code), refused[0].code);
    committed = ok[0];
    const versions = (await pool.query("SELECT version FROM schema_migrations ORDER BY 1")).rows.map((r: any) => r.version);
    assert.deepEqual(versions, ["0001", "0002", "0003", "0004", "0005", "0006", "0007"]);
    assert.deepEqual((await state(pool)).row_counts, { orders: ORDERS, users: UNIQUE_USERS });
  });

  test("committed apply kept pgwarden.bk_0007_* with the pre-migration rows; backups are not effects", async () => {
    assert.equal(committed.applied_version, "0007");
    assert.deepEqual(committed.backup.schema, "pgwarden");
    assert.deepEqual(committed.backup.tables, [
      { table: "orders", backup_table: "pgwarden.bk_0007_orders", rows: ORDERS },
      { table: "users", backup_table: "pgwarden.bk_0007_users", rows: UNIQUE_USERS + DUPES },
    ]);
    assert.deepEqual(committed.backup.skipped, []);
    assert.equal(typeof committed.backup.duration_ms, "number");
    assert.deepEqual(await backupTables(pool), ["bk_0007_orders", "bk_0007_users"]);
    assert.equal((await pool.query("SELECT count(*)::int n FROM pgwarden.bk_0007_users")).rows[0].n, UNIQUE_USERS + DUPES);
    assert.equal((await pool.query("SELECT count(*)::int n FROM pgwarden.bk_0007_users WHERE id > $1", [UNIQUE_USERS])).rows[0].n, DUPES, "the deleted duplicates are in the backup");
    // Backups live outside public: effects and the fingerprint ignore them.
    const s = await state(pool);
    assert.deepEqual(Object.keys(s.row_counts).sort(), ["orders", "users"]);
    const audit = (await pool.query("SELECT detail FROM pgwarden.audit_log WHERE outcome = 'committed'")).rows[0].detail;
    assert.equal(audit.backup.tables.length, 2);
  });

  test("tables above the backup row limit are skipped and listed", async () => {
    const sql = "CREATE INDEX users_city_idx ON users (city);";
    const r = await apply(pool, sql, await rehearse(pool, sql), { row_deltas: { users: 0, orders: 0 }, schema_changes: ["+index:users.users_city_idx"] }, { backupMaxRows: 200 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const b = (r as any).backup;
    assert.deepEqual(b.tables, [{ table: "users", backup_table: "pgwarden.bk_0008_users", rows: UNIQUE_USERS }]);
    assert.equal(b.skipped.length, 1);
    assert.equal(b.skipped[0].table, "orders");
    assert.equal(b.skipped[0].rows, ORDERS);
  });
});

describe("analyze_migration", () => {
  const DB = "pgwarden_test_analyze";
  let pool: Pool;
  const analyze = (sql: string) => withReadOnly(pool, (c) => analyzeMigration(c, sql));
  const find = (r: Awaited<ReturnType<typeof analyze>>, code: string) => r.findings.filter((f) => f.code === code);
  before(async () => {
    pool = createPool(await freshDb(DB));
    await seedMiniProd(pool);
  });
  after(async () => {
    await pool.end();
    await dropDb(DB);
  });

  test("the PR's SQL: MF101 error with the duplicate-group count, BC102 error, POLICY error, PG101 warning", async () => {
    const before = await state(pool);
    const r = await analyze(ORIGINAL_PR_SQL);
    assert.equal(r.statements, 2);
    const [mf101] = find(r, "MF101");
    assert.equal(mf101.severity, "error");
    assert.equal(mf101.statement_index, 0);
    assert.deepEqual(mf101.evidence, { table: "users", key: "lower(email)", rows: UNIQUE_USERS + DUPES, duplicate_groups: DUPES, duplicate_rows: 2 * DUPES, example_count: 2 });
    const [bc102] = find(r, "BC102");
    assert.equal(bc102.severity, "error");
    assert.equal(bc102.statement_index, 1);
    assert.match(bc102.message, /policy refuses/);
    assert.ok(find(r, "POLICY").some((f) => f.statement_index === 1 && f.severity === "error" && /RENAME COLUMN/.test(f.message)));
    assert.equal(find(r, "PG101")[0].severity, "warning");
    assert.equal(r.summary.verdict, "errors");
    assert.deepEqual(await state(pool), before, "analysis changes nothing");
    assert.ok(!JSON.stringify(r).includes("@gmail.com"), "no row values in the report");
  });

  test("the reference fix: no errors (MF101 downgraded because earlier statements rewrite users; DML101 on the backfill)", async () => {
    const r = await analyze(CORRECT_FIX);
    assert.equal(r.summary.errors, 0, JSON.stringify(r.findings, null, 1));
    const [mf101] = find(r, "MF101");
    assert.equal(mf101.severity, "warning");
    assert.equal(mf101.statement_index, 2);
    assert.match(mf101.message, /statement_index 1\)/);
    const [dml] = find(r, "DML101");
    assert.equal(dml.statement_index, 4);
    assert.deepEqual(dml.evidence, { table: "users", rows: UNIQUE_USERS + DUPES });
  });

  test("DML101: UPDATE / DELETE without WHERE carry the exact row count", async () => {
    const r = await analyze("UPDATE users SET city = 'x'; DELETE FROM orders; UPDATE orders SET status = 'x' WHERE id = 1;");
    const d = find(r, "DML101");
    assert.deepEqual(d.map((f) => [f.statement_index, f.severity, f.evidence]), [
      [0, "warning", { table: "users", rows: UNIQUE_USERS + DUPES }],
      [1, "warning", { table: "orders", rows: ORDERS }],
    ]);
    assert.ok(find(r, "POLICY").some((f) => f.statement_index === 1 && /DELETE without WHERE/.test(f.message)));
  });

  test("PG101: CREATE INDEX without CONCURRENTLY -> warning with the table's row count; CONCURRENTLY -> error (can't run in the apply transaction)", async () => {
    const r = await analyze("CREATE INDEX users_city_idx ON users (city);");
    assert.deepEqual(r.findings.map((f) => [f.code, f.severity, f.evidence]), [["PG101", "warning", { table: "users", rows: UNIQUE_USERS + DUPES }]]);
    assert.equal(r.summary.verdict, "warnings");
    const c = await analyze("CREATE INDEX CONCURRENTLY users_city_idx ON users (city);");
    assert.deepEqual(c.findings.map((f) => [f.code, f.severity]), [["PG101", "error"]]);
  });

  test("MF101 info when there are no duplicates; unique constraint path; unsupported expression -> warning", async () => {
    const r = await analyze("CREATE UNIQUE INDEX users_email_uniq ON users (email); ALTER TABLE users ADD CONSTRAINT u UNIQUE (email, city); CREATE UNIQUE INDEX x ON users (md5(email));");
    const m = find(r, "MF101");
    assert.deepEqual(m.map((f) => [f.statement_index, f.severity]), [[0, "info"], [1, "info"], [2, "warning"]]);
    assert.equal(m[0].evidence!.duplicate_groups, 0);
  });

  test("MF104 SET NOT NULL counts NULLs; MF103 ADD COLUMN NOT NULL without DEFAULT; PG301/PG302/PG305/PG306; BC101/DS102/DS103", async () => {
    const nulls = (await pool.query("SELECT count(*)::int n FROM users WHERE phone IS NULL")).rows[0].n;
    const r = await analyze(
      `ALTER TABLE users ALTER COLUMN phone SET NOT NULL;
       ALTER TABLE users ADD COLUMN a int NOT NULL, ADD COLUMN b timestamptz NOT NULL DEFAULT now(), ADD COLUMN c double precision DEFAULT random();
       ALTER TABLE users ALTER COLUMN city TYPE varchar(10);
       ALTER TABLE orders ADD CONSTRAINT ck CHECK (amount_paise < 10000000), ADD CONSTRAINT ck2 CHECK (amount_paise > 1) NOT VALID;
       ALTER TABLE orders ADD CONSTRAINT fk2 FOREIGN KEY (user_id) REFERENCES users (id);
       ALTER TABLE users RENAME TO customers;
       DROP TABLE orders;
       ALTER TABLE users DROP COLUMN city;`,
    );
    const one = (code: string) => find(r, code).map((f) => [f.statement_index, f.severity]);
    assert.ok(nulls > 0);
    assert.deepEqual(find(r, "MF104")[0].evidence, { table: "users", column: "phone", rows: UNIQUE_USERS + DUPES, null_rows: nulls });
    assert.deepEqual(one("MF104"), [[0, "error"]]);
    assert.deepEqual(one("MF103"), [[1, "error"]]); // only `a`: `b` has a DEFAULT
    assert.deepEqual(one("PG302"), [[1, "warning"]]); // only random(): now() is stable, not volatile
    assert.deepEqual(one("PG301"), [[2, "warning"]]);
    assert.deepEqual(one("PG305"), [[3, "warning"]]); // ck2 is NOT VALID
    assert.deepEqual(one("PG306"), [[4, "warning"]]);
    assert.deepEqual(one("BC101"), [[5, "error"]]);
    assert.deepEqual(one("DS102"), [[6, "error"]]);
    assert.deepEqual(find(r, "DS102")[0].evidence, { table: "orders", rows: ORDERS });
    assert.deepEqual(one("DS103"), [[7, "error"]]);
  });

  test("SET NOT NULL after a backfill in the same migration is downgraded to a warning", async () => {
    const r = await analyze("UPDATE users SET phone = '0' WHERE phone IS NULL; ALTER TABLE users ALTER COLUMN phone SET NOT NULL;");
    assert.deepEqual(find(r, "MF104").map((f) => f.severity), ["warning"]);
    assert.equal(r.summary.errors, 0);
  });

  test("unparseable SQL is a POLICY error, not a crash", async () => {
    const r = await analyze("this is not sql;");
    assert.deepEqual(r.findings.map((f) => [f.code, f.severity, f.statement_index]), [["POLICY", "error", null]]);
  });
});
