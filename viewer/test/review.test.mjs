import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewMigration, splitStatements } from "../public/review.mjs";

const PROTECTED = ["payments", "refunds"];

test("zero-loss fix from the protected-tables run -> allow", () => {
  const r = reviewMigration({
    sql: `-- grandfather legacy rows
ALTER TABLE payments
  ADD CONSTRAINT payments_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) NOT VALID;
ALTER TABLE payments
  ADD CONSTRAINT payments_merchant_id_required CHECK (merchant_id IS NOT NULL) NOT VALID;
CREATE UNIQUE INDEX payments_upi_txn_ref_key ON payments (upi_txn_ref) WHERE id > 30055;`,
    effects: { row_deltas: { customers: 0, merchants: 0, payments: 0, refunds: 0 } },
    protectedTables: PROTECTED,
  });
  assert.equal(r.verdict, "allow");
  assert.equal(r.statements.length, 3);
  assert.match(r.statements[0].text, /new and updated rows only/);
  assert.match(r.statements[2].text, /unique index on payments\(upi_txn_ref\), only for rows where id > 30055/);
  assert.deepEqual(r.reasons, []);
});

test("the -119 / -11 fix -> deny, protected rows named", () => {
  const r = reviewMigration({
    sql: `DELETE FROM payments p USING payments q WHERE p.upi_txn_ref = q.upi_txn_ref AND p.id > q.id;
DELETE FROM payments p WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = p.customer_id);
DELETE FROM payments p WHERE p.merchant_id IS NULL;
ALTER TABLE payments ADD CONSTRAINT payments_upi_txn_ref_key UNIQUE (upi_txn_ref);
ALTER TABLE payments ALTER COLUMN merchant_id SET NOT NULL;`,
    effects: { row_deltas: { customers: 0, merchants: 0, payments: -119, refunds: -11 } },
    protectedTables: PROTECTED,
  });
  assert.equal(r.verdict, "deny");
  assert.ok(r.reasons.some((x) => /119 row\(s\) from payments, a protected/.test(x)));
  assert.ok(r.reasons.some((x) => /11 row\(s\) from refunds/.test(x)));
  assert.match(r.statements[0].text, /Deletes rows from payments .*CASCADE/);
});

test("without protected tables, deletions still need a careful review", () => {
  const r = reviewMigration({ sql: "DELETE FROM payments WHERE merchant_id IS NULL;", effects: { row_deltas: { payments: -64 } } });
  assert.equal(r.verdict, "review");
  assert.ok(r.reasons.some((x) => /Removes 64 row\(s\) from payments/.test(x)));
});

test("UPDATE with zero row deltas is not low risk (effects can't see values)", () => {
  const r = reviewMigration({ sql: "UPDATE payments SET amount = amount * 100;", effects: { row_deltas: { payments: 0 } } });
  assert.equal(r.verdict, "review");
  assert.match(r.headline, /writes data/);
});

test("DROP TABLE -> deny", () => {
  assert.equal(reviewMigration({ sql: "DROP TABLE orders;", effects: {} }).verdict, "deny");
});

test("statement split ignores semicolons in comments, strings and dollar quotes", () => {
  assert.equal(splitStatements("-- a; b\nCOMMENT ON TABLE x IS 'a;b'; SELECT $q$;$q$;").length, 2);
});
