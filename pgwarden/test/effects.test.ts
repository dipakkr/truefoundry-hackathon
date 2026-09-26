import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { diffFacts, effectsMatch, snapshotFacts, type Facts } from "../src/effects.js";
import { createPool, dropDb, freshDb, GOLDEN, seedMiniProd, type Pool } from "./helpers.js";

function applyPatch(base: Facts, patch: any[]): Facts {
  const f: Facts = structuredClone(base);
  for (const p of patch) {
    const t = f.tables[p.table];
    switch (p.op) {
      case "set_rows": t.row_count = p.row_count; break;
      case "add_index": t.indexes.push(p.name); break;
      case "add_column": t.columns[p.column] = { type: p.type, nullable: p.nullable }; break;
      case "rename_column": t.columns[p.to] = t.columns[p.from]; delete t.columns[p.from]; break;
      case "drop_table": delete f.tables[p.table]; break;
      case "alter_column":
        if (p.type !== undefined) t.columns[p.column].type = p.type;
        if (p.nullable !== undefined) t.columns[p.column].nullable = p.nullable;
        break;
      default: throw new Error(`unknown patch op ${p.op}`);
    }
  }
  return f;
}

describe("effects golden fixture (fixtures/effects-golden.json)", () => {
  for (const c of GOLDEN.cases) {
    test(c.name, () => {
      const beforeFacts: Facts = c.before === "base" ? GOLDEN.base : c.before;
      const actual = diffFacts(beforeFacts, applyPatch(beforeFacts, c.patch));
      assert.deepEqual(actual, c.expected); // exact, incl. sort order and zero deltas
    });
  }
});

describe("effectsMatch (CONTRACTS §7 comparison)", () => {
  const actual = { row_deltas: { users: -14, orders: 0 }, schema_changes: ["+column:users.mobile", "+index:users.users_email_lower_uniq"] };
  test("set equality on schema_changes, order-insensitive", () =>
    assert.ok(effectsMatch({ row_deltas: { orders: 0, users: -14 }, schema_changes: [...actual.schema_changes].reverse() }, actual)));
  test("row delta off by one fails", () =>
    assert.ok(!effectsMatch({ ...actual, row_deltas: { users: -13, orders: 0 } }, actual)));
  test("missing schema change fails", () =>
    assert.ok(!effectsMatch({ ...actual, schema_changes: ["+column:users.mobile"] }, actual)));
  test("extra schema change fails", () =>
    assert.ok(!effectsMatch({ ...actual, schema_changes: [...actual.schema_changes, "-column:users.phone"] }, actual)));
});

describe("effects engine on a live database", () => {
  const DB = "pgwarden_test_effects";
  let pool: Pool;
  before(async () => {
    pool = createPool(await freshDb(DB));
    await seedMiniProd(pool);
  });
  after(async () => {
    await pool.end();
    await dropDb(DB);
  });

  // Runs sql in a transaction that is always rolled back; returns the diff.
  async function effectsOf(sql: string) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const b = await snapshotFacts(c);
      await c.query(sql);
      return diffFacts(b, await snapshotFacts(c));
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  test("snapshot matches the golden base shape (types, indexes, constraints)", async () => {
    const c = await pool.connect();
    try {
      const f = await snapshotFacts(c);
      for (const t of ["users", "orders"]) {
        assert.deepEqual(f.tables[t].columns, GOLDEN.base.tables[t].columns);
        assert.deepEqual(f.tables[t].indexes, GOLDEN.base.tables[t].indexes);
        assert.deepEqual(f.tables[t].constraints, GOLDEN.base.tables[t].constraints);
      }
      assert.ok(!("schema_migrations" in f.tables));
    } finally {
      c.release();
    }
  });

  test("add index", async () =>
    assert.deepEqual(await effectsOf("CREATE INDEX users_city_idx ON users (city)"), {
      row_deltas: { orders: 0, users: 0 },
      schema_changes: ["+index:users.users_city_idx"],
    }));
  test("add column", async () =>
    assert.deepEqual(await effectsOf("ALTER TABLE users ADD COLUMN mobile text"), {
      row_deltas: { orders: 0, users: 0 },
      schema_changes: ["+column:users.mobile"],
    }));
  test("rename column -> -column + +column", async () =>
    assert.deepEqual(await effectsOf("ALTER TABLE users RENAME COLUMN phone TO mobile"), {
      row_deltas: { orders: 0, users: 0 },
      schema_changes: ["+column:users.mobile", "-column:users.phone"],
    }));
  test("delete 14 rows", async () =>
    assert.deepEqual(await effectsOf("DELETE FROM orders WHERE user_id > 100; DELETE FROM users WHERE id > 100"), {
      row_deltas: { orders: -25, users: -14 },
      schema_changes: [],
    }));
  test("schema_migrations inserts are not effects", async () =>
    assert.deepEqual(await effectsOf("INSERT INTO schema_migrations (version) VALUES ('9999')"), {
      row_deltas: { orders: 0, users: 0 },
      schema_changes: [],
    }));
});
