# pgwarden: the only door to prod

MCP server (Streamable HTTP, stateless) that exposes prod Postgres to the Migration Rehearsal agent.
Reads are masked and read-only. The only write to prod is `apply_migration`, and it applies only SQL that passed a rehearsal.

## Run

```sh
npm --prefix pgwarden install
npm --prefix pgwarden start      # http://localhost:${PGWARDEN_PORT}/mcp
npm --prefix pgwarden test       # typecheck + tests (needs the Postgres server from DATABASE_URL)
```

Every request needs `Authorization: Bearer ${PGWARDEN_TOKEN}`. Without it the server returns 401. Only `POST /mcp` is served.
Tests create and drop their own `pgwarden_test*` databases on the same server. They never write to the `DATABASE_URL` database.

## Env (read from the repo-root `.env`)

| Var | Meaning |
|---|---|
| `DATABASE_URL` | the "prod" database |
| `PGWARDEN_PORT` | listen port (default 8787) |
| `PGWARDEN_TOKEN` | bearer token required on every request |
| `PGWARDEN_MASK_KEY` | key for the deterministic masking cipher |

## Tools (CONTRACTS §5)

| Tool | Annotations | What it does |
|---|---|---|
| `describe_schema` | readOnly | Lists the `public` tables in FK order, with columns, indexes, constraints and FKs. Each table also carries `create_sql` and `index_sql`, which are runnable. |
| `profile_table` | readOnly | Returns the exact row count plus per-column `null_count` and plain `distinct_count` |
| `export_table` | readOnly | Exports a full table in pages ordered by PK (max 5000 rows per page), with `users.email` (local part), `full_name` and `phone` masked |
| `record_rehearsal` | not readOnly, not destructive | Stores `{verdict, report, sha256(sql.trim())}` plus prod's current schema fingerprint (computed by the server, same function as `verify_prod_state`) in `pgwarden.rehearsals`. Returns `rh_xxxxxx` and `prod_fingerprint` |
| `apply_migration` | destructive (gated by name in the agent spec) | Runs the algorithm below |
| `verify_prod_state` | readOnly | Returns row counts, a schema fingerprint, the `users` columns, whether the lower-email index exists, and the last applied version |
| `analyze_migration` | readOnly | Risk report for a migration (Atlas / Squawk style), see below. Not in the agent's `enable_tools` |

Read tools run inside `BEGIN READ ONLY`. Audit data lives in schema `pgwarden`, which is outside `public`, so it never shows up in effects or in `verify_prod_state`. That schema is re-created on demand after `reset` drops it.

## apply_migration algorithm

1. Parse the SQL with libpg_query and walk the whole tree. Refuse with `POLICY_REFUSED` on any of: DROP TABLE/SCHEMA/DATABASE, TRUNCATE, DROP COLUMN, any RENAME, DELETE without WHERE, GRANT/REVOKE, role changes, BEGIN/COMMIT, SET, DO, or more than 20 statements.
2. `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'`, then `pg_try_advisory_xact_lock(7070707001)`. If another apply holds it, refuse with `APPLY_IN_PROGRESS` (deploy-queue semantics: one apply at a time, no waiting, no deadlock). The lock is taken before the rehearsal lookup, so an apply that runs after another one committed sees it and gets `ALREADY_APPLIED`.
3. Look up the rehearsal (row-locked). The checks, with their refusal codes: it must exist (`REHEARSAL_NOT_FOUND`), have verdict pass (`REHEARSAL_FAILED`), have a matching sha256 of `sql.trim()` (`REHEARSAL_MISMATCH`), be less than 30 minutes old (`REHEARSAL_STALE`), and not have been applied already (`ALREADY_APPLIED`).
4. Snapshot the facts. **Drift check (Atlas-style):** the schema fingerprint of that snapshot must equal the one stored by `record_rehearsal`, otherwise `DRIFT_DETECTED` with `{rehearsed_fingerprint, current_fingerprint}`: prod's schema changed since the rehearsal, so rehearse again. Rehearsals recorded before this check existed (NULL fingerprint) skip it. Data drift (same schema, different rows) is caught by step 6.
5. **Pre-apply backup (Bytebase-style undo):** every `public` table except `schema_migrations` with at most 1,000,000 rows (exact count from the snapshot) is copied to `pgwarden.bk_<version>_<table>` (`CREATE TABLE … AS TABLE …`, data only, no indexes), where `<version>` is the version this apply will get. It runs inside the transaction: a refused or rolled-back apply leaves no backup, a committed one keeps it. Larger tables are listed in `backup.skipped`; at real scale use point-in-time recovery or a Neon/PlanetScale-style branch instead of copying. Measured at demo scale (5,014 users + 20,000 orders): about 8 ms warm (up to ~60 ms cold) on top of a ~60 ms apply. Backups are never pruned automatically; `npm run reset` drops them with the `pgwarden` schema.
6. Run the SQL and snapshot again. The two snapshots give `actual_effects` (CONTRACTS §7). If they differ from `declared_effects`, ROLLBACK and return `EFFECTS_MISMATCH` with both. Row deltas must match exactly, and schema_changes are compared as sets.
7. Otherwise insert the next version (`0007`) into `schema_migrations`, mark the rehearsal applied, write the audit row, and COMMIT. The response is `{status, applied_version, actual_effects, duration_ms, backup: {schema: "pgwarden", tables: [{table, backup_table, rows}], skipped: [{table, rows, reason}], duration_ms}}`.
8. On any Postgres error, ROLLBACK and return `SQL_ERROR` with the Postgres message.

To undo a committed migration's data changes by hand, read from `pgwarden.bk_<version>_<table>` (for example re-insert deleted rows with `INSERT … SELECT … WHERE id NOT IN (…)`).

## analyze_migration

Input `{sql}`. It runs in a READ ONLY transaction with a 20 s statement timeout and **never executes the submitted SQL**. It parses the SQL with libpg_query and, for data-aware checks, runs aggregates it builds itself from catalog-validated identifiers (plain columns or `lower(col)` only). Evidence contains counts only, never row values, so it cannot leak unmasked PII.

Output: `{statements, findings: [{code, severity: "error"|"warning"|"info", statement_index (0-based, null = whole script), message, evidence?}], summary: {errors, warnings, info, verdict: "errors"|"warnings"|"clean", text}}`.

| Code (Squawk rule) | Severity | Finding |
|---|---|---|
| `MF101` (disallowed-unique-constraint) | error if duplicates, else info | Unique index or UNIQUE/PK constraint: counts duplicate groups on prod. Evidence: `{table, key, rows, duplicate_groups, duplicate_rows, example_count}` (`example_count` = size of the largest group). A warning when the key is not a plain column / `lower(col)`, the index is partial, or the column does not exist yet |
| `MF104` (adding-not-nullable-field) | error if NULLs, else info | `SET NOT NULL`: counts NULL rows (`null_rows`) |
| `MF103` (adding-required-field) | error | `ADD COLUMN … NOT NULL` without DEFAULT on a populated table (info if empty) |
| `BC101` / `BC102` (renaming-table / renaming-column) | error | Rename breaks running clients; pgwarden policy refuses it |
| `DS101` / `DS102` / `DS103` (ban-drop-table / ban-drop-column) | error | DROP SCHEMA / TABLE / COLUMN; policy-refused |
| `PG101` (require-concurrent-index-creation) | warning | CREATE INDEX without CONCURRENTLY blocks writes; evidence is the table's row count. pgwarden applies in one transaction, so CONCURRENTLY is not possible there (an error if the SQL uses it) |
| `PG301` (changing-column-type) | warning | ALTER COLUMN TYPE can rewrite the table |
| `PG302` (adding-field-with-default) | warning | ADD COLUMN with a volatile default (`pg_proc.provolatile = 'v'`, or serial/identity) rewrites the table |
| `PG305` / `PG306` (constraint-missing-not-valid) | warning | CHECK / FOREIGN KEY without NOT VALID scans the table under lock |
| `DML101` | warning | UPDATE or DELETE without WHERE; evidence is the exact row count of the target table |
| `POLICY` | error | Anything `apply_migration` would refuse with `POLICY_REFUSED` (same rules, per statement) |

Checks run against prod as it is now. If an earlier statement of the same migration writes the table (UPDATE/DELETE/INSERT/MERGE), a data error (MF101, MF104) is downgraded to a warning, because that statement may fix the data first. The rehearsal is what proves it. So on the demo data, the PR's SQL gets MF101 (14 duplicate groups), BC102 and POLICY errors, while the reference fix gets only warnings.
