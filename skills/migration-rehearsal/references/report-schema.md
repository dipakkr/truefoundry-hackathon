# RehearsalReport and effects format

Copied verbatim from the project's frozen CONTRACTS.md (sections 7 and 8). Your report must match this shape;
`effects` must come from `scripts/effects.py` (`diff(snapshot_before, snapshot_after)`), which passes
`references/effects-golden.json` — the same fixture pgwarden's server-side check passes.

Notes for the sandbox:
- `fixtures/effects-golden.json` in the text below is shipped here as `references/effects-golden.json`.
- `pr` is `<owner>/<repo>#<number>`; `migration_sha256` is the sha256 hex of the exact SQL string passed to `record_rehearsal`.
- `pg.prod_version` comes from `describe_schema.pg_version`; `pg.sandbox_version` from `select version()` in the sandbox.
- Example values below are illustrative, not expected answers.

## 7. Effects normalization (shared by the sandbox report and the server)

- `row_deltas`: `{table: after_count - before_count}` for every table in `public` except `schema_migrations`. Zero deltas are **included**.
- `schema_changes`: sorted list of strings:
  - `+table:<t>` / `-table:<t>`
  - `+column:<t>.<c>` / `-column:<t>.<c>` / `~column:<t>.<c>:<old_type>-><new_type>` / `~nullable:<t>.<c>:<bool>-><bool>`
  - `+index:<t>.<index_name>` / `-index:<t>.<index_name>`
  - `+constraint:<t>.<name>` / `-constraint:<t>.<name>`
- A rename shows up as `-column:users.phone` + `+column:users.mobile` in effects (the policy pre-check refuses `RENAME` before execution anyway).
- **Comparison rule (everyone: server, sandbox, e2e):** `row_deltas` exact per-key equality; `schema_changes` **set** equality.
- **Single implementation of truth:** the golden fixture `fixtures/effects-golden.json` (before-facts, after-facts, expected effects; 5 cases: add index, add column, rename, delete rows, no-op). WS1's TS diff and the skill's `effects.py` must both pass it. Owner: WS1 writes it by 13:30.

## 8. RehearsalReport (JSON, printed by the sandbox script, passed to `record_rehearsal`)

```
{
  "version": 1,
  "pr": "<owner>/shopkart#1",
  "migration_sha256": "<hex>",
  "attempt": 1,
  "pg": {"sandbox_version": "16.x", "prod_version": "16.x"},
  "source_rows": {"users": 1200, "orders": 4800},
  "steps": [{"index": 1, "sql_preview": "CREATE UNIQUE INDEX …", "ok": false, "ms": 41, "error": "could not create unique index …"}],
  "constraint_violations": [{"constraint": "users_email_lower_uniq", "violating_groups": 3, "examples_masked": ["…"]}],
  "query_replay": [{"file": "src/queries/notify_user.sql", "ok": false, "error": "column \"phone\" does not exist"}],
  "invariants": [{"name": "orders_fk_intact", "ok": true}, {"name": "no_orphan_orders", "ok": true}, {"name": "row_count_users_expected", "ok": true, "detail": "-3"}],
  "effects": {"row_deltas": {"users": -3, "orders": 0}, "schema_changes": ["+column:users.mobile", "+index:users.users_email_lower_uniq"]},
  "verdict": "pass | fail",
  "duration_ms": 0
}
```
`verdict = pass` only if every step is ok, query_replay is all ok, and invariants are all ok.
