# WS1: pgwarden MCP server ("the only door to prod")

**Owner:** Person B. **Time box:** 12:00–15:30 (skeleton by 13:30).
**Inputs:** CONTRACTS.md §1, §3–§8 (tool names, args, annotations, masking, effects, refusal codes are frozen).
**Blocked by:** nothing (use a local Postgres or the Neon DB as soon as WS2 seeds it; WS2 shares `schema.sql` by 12:30).
**Outputs:** `pgwarden/` in the main repo; `npm run pgwarden` starts it on `:8787/mcp`.

## Design rules
- TypeScript, `@modelcontextprotocol/sdk`, **Streamable HTTP** transport, stateless mode is fine.
- Every request must carry `Authorization: Bearer ${PGWARDEN_TOKEN}`, otherwise 401 / `UNAUTHORIZED`.
- Annotations exactly as in CONTRACTS §5. `apply_migration` has `destructiveHint: true` **and** gets gated by name in the agent spec (belt and braces).
- **Read tools use a read-only transaction** (`BEGIN READ ONLY`). Only `record_rehearsal` (audit table) and `apply_migration` write.
- Rehearsal records and the audit log live in a table `pgwarden_audit` in a **separate schema** `pgwarden` (so they're excluded from effects and `verify_prod_state`). `reset` drops it.
- Log every call as one line to stdout: tool, duration, outcome (never log the SQL args of other tools' results or any secrets).

## Tasks

### T1. Skeleton (by 13:15)
- [ ] Server + auth + the 6 tools registered with the correct schemas and annotations. `describe_schema` and `verify_prod_state` real; others may return stub JSON of the correct shape.
- [ ] Tell WS4 it's up so `setup` can register it.

### T2. Read tools (by 13:45)
- [ ] `describe_schema` from `information_schema` + `pg_indexes` + `pg_constraint`, **including `create_sql` and `index_sql`** per table (CONTRACTS §5). Test: build an empty DB from `create_sql` + `index_sql`; its `describe_schema` must equal prod's (except row counts).
- [ ] `profile_table`: exact `count(*)`, per column `count(*) - count(col)` and `count(distinct col)`. **No `lower()`** (see CONTRACTS §5).
- [ ] `export_table`: paged by PK, masked (T3), `has_more` correct.
- [ ] Validate `table`/`columns` against the real schema (allowlist); never interpolate raw identifiers.

### T3. Masking (by 14:15)
- [ ] Deterministic case-preserving substitution cipher (CONTRACTS §4).
- [ ] Unit tests: the two equality properties; a known L1 duplicate pair stays a `lower()`-duplicate after masking and is **not** an exact duplicate; digits stay digits; the domain is unchanged.

### T4. Effects engine (golden fixture by 13:30, engine by 14:45)
- [ ] **First**, write `fixtures/effects-golden.json` (CONTRACTS §7: 5 cases) and hand it to WS3; `effects.py` in the skill must pass the same fixture.
- [ ] A function that snapshots `{row_counts, columns, indexes, constraints, tables}` for schema `public`, and a diff that returns `{row_deltas, schema_changes}` in the exact format of CONTRACTS §7 (sorted, zero deltas included, `schema_migrations` excluded).
- [ ] Tests: add index → `+index:…`; rename → `-column` + `+column`; delete 14 rows → `users: -14`.

### T5. `record_rehearsal` + `apply_migration` (by 15:30)
- [ ] `record_rehearsal`: store `{id (short, e.g. rh_ + 6 chars), sql_sha256, verdict, report, created_at}`.
- [ ] `apply_migration`: implement the **exact algorithm in CONTRACTS §5** (policy pre-check → rehearsal lookup → txn with timeouts → actual vs declared → COMMIT/ROLLBACK). Record the version in `schema_migrations`.
- [ ] Statement splitting: use a real splitter that handles `$$` bodies and quoted semicolons (a library like `pgsql-ast-parser` or `pg-query-parser`/libpg_query-based wasm). Do not use a naive `split(';')`.
- [ ] Error payloads are human-readable. The agent will quote them to the user.

### T6. Refusal tests (by 15:30), each one scripted
| Case | Expected |
|---|---|
| `DROP TABLE orders;` (the injection) | `POLICY_REFUSED` before any DB work |
| Original PR SQL (contains `RENAME COLUMN`) | `POLICY_REFUSED` (pre-check, before any DB work) |
| Correct fix, declared `users: -13` | `EFFECTS_MISMATCH`, then ROLLBACK, and prod unchanged (check with `verify_prod_state`) |
| SQL differs by one char from the rehearsed SQL | `REHEARSAL_MISMATCH` |
| Correct fix, correct declaration | `committed`, `users` = 5,000 |
| Apply the same rehearsal twice | `ALREADY_APPLIED` |

## Done when
- `npm -w pgwarden test` passes (masking, effects, refusal table).
- MCP Inspector (or `curl` JSON-RPC) lists the 6 tools with the correct annotations.
- From TrueForge, a scratch agent can call `describe_schema` and gets a card; `apply_migration` shows the Allow/Deny card.

## Cut first
Paging edge cases (the demo tables fit in 5 pages) → fancy log output → the `REHEARSAL_STALE` check. **Never cut:** policy pre-check, effects verification in a txn, auth.
