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
| `record_rehearsal` | not readOnly, not destructive | Stores `{verdict, report, sha256(sql.trim())}` in `pgwarden.rehearsals` and returns `rh_xxxxxx` |
| `apply_migration` | destructive (gated by name in the agent spec) | Runs the algorithm below |
| `verify_prod_state` | readOnly | Returns row counts, a schema fingerprint, the `users` columns, whether the lower-email index exists, and the last applied version |

Read tools run inside `BEGIN READ ONLY`. Audit data lives in schema `pgwarden`, which is outside `public`, so it never shows up in effects or in `verify_prod_state`. That schema is re-created on demand after `reset` drops it.

## apply_migration in 6 lines

1. Parse the SQL with libpg_query and walk the whole tree. Refuse with `POLICY_REFUSED` on any of: DROP TABLE/SCHEMA/DATABASE, TRUNCATE, DROP COLUMN, any RENAME, DELETE without WHERE, GRANT/REVOKE, role changes, BEGIN/COMMIT, SET, DO, or more than 20 statements.
2. Look up the rehearsal (row-locked). The checks, with their refusal codes: it must exist (`REHEARSAL_NOT_FOUND`), have verdict pass (`REHEARSAL_FAILED`), have a matching sha256 of `sql.trim()` (`REHEARSAL_MISMATCH`), be less than 30 minutes old (`REHEARSAL_STALE`), and not have been applied already (`ALREADY_APPLIED`).
3. Run `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'`, then snapshot the facts, run the SQL, and snapshot again. The two snapshots give `actual_effects` (CONTRACTS §7).
4. If `actual_effects` differs from `declared_effects`, ROLLBACK and return `EFFECTS_MISMATCH` with both. Row deltas must match exactly, and schema_changes are compared as sets.
5. Otherwise insert the next version (`0007`) into `schema_migrations`, mark the rehearsal applied, write the audit row, and COMMIT.
6. On any Postgres error, ROLLBACK and return `SQL_ERROR` with the Postgres message.
