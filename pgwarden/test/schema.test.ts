import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { exportTable, profileTable } from "../src/data.js";
import { withReadOnly } from "../src/db.js";
import { createMasker } from "../src/mask.js";
import { describeSchema, verifyProdState, type SchemaDescription } from "../src/schema.js";
import { createPool, dropDb, DUPES, freshDb, ORDERS, seedMiniProd, UNIQUE_USERS, type Pool } from "./helpers.js";

const SRC = "pgwarden_test_rt_src";
const COPY = "pgwarden_test_rt_copy";
const strip = (d: SchemaDescription) => ({ ...d, tables: d.tables.map(({ row_estimate, ...t }) => t) });

describe("describe_schema create_sql/index_sql round-trip + masked export", () => {
  let src: Pool, copy: Pool;
  let desc: SchemaDescription;
  const masker = createMasker("round-trip-key");

  before(async () => {
    src = createPool(await freshDb(SRC));
    copy = createPool(await freshDb(COPY));
    await seedMiniProd(src);
    desc = await withReadOnly(src, (c) => describeSchema(c));
  });
  after(async () => {
    await src.end();
    await copy.end();
    await dropDb(SRC);
    await dropDb(COPY);
  });

  test("output shape and FK order", () => {
    assert.match(desc.pg_version, /^\d+/);
    assert.deepEqual(desc.tables.map((t) => t.name).sort(), ["orders", "schema_migrations", "users"]);
    const names = desc.tables.map((t) => t.name);
    assert.ok(names.indexOf("users") < names.indexOf("orders"), "users must precede orders (FK order)");
    const users = desc.tables.find((t) => t.name === "users")!;
    assert.equal(users.row_estimate, UNIQUE_USERS + DUPES);
    assert.deepEqual(users.columns[0], { name: "id", type: "bigint", nullable: false, default: "nextval('users_id_seq'::regclass)" });
    const orders = desc.tables.find((t) => t.name === "orders")!;
    assert.deepEqual(orders.foreign_keys, [{ name: "orders_user_id_fkey", column: "user_id", ref_table: "users", ref_column: "id" }]);
    assert.deepEqual(orders.index_sql, ["CREATE INDEX orders_user_id_idx ON public.orders USING btree (user_id)"]);
    assert.deepEqual(orders.constraints.map((c) => c.type).sort(), ["CHECK", "FOREIGN KEY", "PRIMARY KEY"]);
  });

  test("an empty DB built from create_sql + index_sql describes identically (except row counts)", async () => {
    for (const t of desc.tables) await copy.query(t.create_sql);
    for (const t of desc.tables) for (const s of t.index_sql) await copy.query(s);
    const copyDesc = await withReadOnly(copy, (c) => describeSchema(c));
    assert.deepEqual(strip(copyDesc), strip(desc));
    const a = await withReadOnly(src, verifyProdState), b = await withReadOnly(copy, verifyProdState);
    assert.equal(b.schema_fingerprint, a.schema_fingerprint);
  });

  test("masked export (paged) loads into the copy and keeps the L1 landmine intact", async () => {
    for (const table of ["users", "orders"]) {
      let page = 0, loaded = 0, total = -1;
      for (;;) {
        const r = await withReadOnly(src, (c) => exportTable(c, masker, table, page, 40));
        total = r.total_rows;
        for (const row of r.rows) {
          const ph = row.map((_, i) => `$${i + 1}`).join(",");
          await copy.query(`INSERT INTO ${table} (${r.columns.join(",")}) VALUES (${ph})`, row);
        }
        loaded += r.rows.length;
        if (!r.has_more) break;
        page++;
      }
      assert.equal(loaded, total);
    }
    const counts = (await copy.query("SELECT (SELECT count(*) FROM users)::int u, (SELECT count(*) FROM orders)::int o")).rows[0];
    assert.deepEqual(counts, { u: UNIQUE_USERS + DUPES, o: ORDERS });

    const q = `SELECT count(DISTINCT email)::int exact, count(DISTINCT lower(email))::int lowered, count(DISTINCT full_name)::int names FROM users`;
    assert.deepEqual((await copy.query(q)).rows[0], (await src.query(q)).rows[0]);
    const srcEmails = (await src.query("SELECT email FROM users ORDER BY id LIMIT 3")).rows.map((r: any) => r.email);
    const copyEmails = (await copy.query("SELECT email FROM users ORDER BY id LIMIT 3")).rows.map((r: any) => r.email);
    assert.notDeepEqual(copyEmails, srcEmails, "emails must be masked");
    assert.ok(copyEmails.every((e: string) => e.endsWith("@gmail.com")), "domain kept");

    await assert.rejects(copy.query("CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email))"), /could not create unique index/);
    await copy.query("CREATE UNIQUE INDEX users_email_exact_uniq ON users (email)"); // exact UNIQUE passes, as on prod
  });

  test("export_table page bounds, has_more, ordering", async () => {
    const last = await withReadOnly(src, (c) => exportTable(c, masker, "orders", 0, 5000));
    assert.equal(last.has_more, false);
    assert.equal(last.rows.length, ORDERS);
    assert.deepEqual(last.rows.slice(0, 3).map((r) => r[0]), [1, 2, 3]);
    const p = await withReadOnly(src, (c) => exportTable(c, masker, "orders", 1, 100));
    assert.equal(p.has_more, true);
    assert.equal(p.rows[0][0], 101);
    await assert.rejects(withReadOnly(src, (c) => exportTable(c, masker, "orders; DROP TABLE users", 0, 10)), /does not exist/);
    await assert.rejects(withReadOnly(src, (c) => exportTable(c, masker, "orders", 0, 5001)), /page_size/);
  });

  test("profile_table uses plain distinct (no lower())", async () => {
    const p = await withReadOnly(src, (c) => profileTable(c, "users", ["email", "phone"]));
    assert.equal(p.row_count, UNIQUE_USERS + DUPES);
    const email = p.columns.find((c) => c.name === "email")!;
    assert.equal(email.distinct_count, UNIQUE_USERS + DUPES); // case variants count as distinct
    assert.equal(email.null_count, 0);
    assert.ok(p.columns.find((c) => c.name === "phone")!.null_count > 0);
    await assert.rejects(withReadOnly(src, (c) => profileTable(c, "users", ["nope"])), /unknown column/);
  });
});
