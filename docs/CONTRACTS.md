# Frozen Contracts

Every workstream builds against these. **Change = team announcement + edit this file in the same commit.**

---

## 1. Env vars and ports (`.env.example`)

| Var | Used by | Example / notes |
|---|---|---|
| `DATABASE_URL` | pgwarden, seed, reset | Neon "prod" connection string (`sslmode=require`) |
| `PGWARDEN_PORT` | pgwarden | `8787` (endpoint `http://localhost:8787/mcp`) |
| `PGWARDEN_TOKEN` | pgwarden, setup | random 32+ chars; TrueForge sends `Authorization: Bearer <token>` |
| `PGWARDEN_MASK_KEY` | pgwarden | random string; seeds the deterministic substitution cipher |
| `TRUEFORGE_BASE_URL` | setup, e2e | `http://localhost:8790` |
| `TFY_GATEWAY_BASE_URL` | setup | TrueFoundry AI Gateway OpenAI-compatible base URL |
| `TFY_GATEWAY_API_KEY` | setup | gateway key with a **budget limit** set in the gateway |
| `MODEL_ID` | setup | model id exposed through the gateway (chosen in WS0) |
| `DAYTONA_API_KEY` | setup | must have **Sandboxes + Snapshots write** |
| `SHOPKART_REPO` | setup, e2e, agent prompt | `<github-user>/shopkart` |
| `SKILL_REPO_URL` | setup | `https://github.com/<github-user>/truefoundry-hackathon` |
| `PR_NUMBER` | e2e, demo | `1` on stage, `2` for e2e |
| `SKILL_REF` | setup | `main` until the 16:00 freeze, then a commit SHA |

Ports: TrueForge `8790`, pgwarden `8787`. Nothing else listens.

## 2. TrueForge resource names

| Resource | Name | Registered via |
|---|---|---|
| Model provider | `tfy-gateway` (type `custom`) | `PUT /api/v1/settings/model-providers` |
| Model FQN in agent spec | `tfy-gateway/${MODEL_ID}` | – |
| Sandbox provider | Daytona | `PUT /api/v1/settings/sandbox-providers` (or UI once) |
| MCP server (ours) | `pgwarden`, `type: remote`, `url: http://localhost:8787/mcp`, `auth: {type: header, headers: {Authorization: "Bearer ${PGWARDEN_TOKEN}"}}` | `PUT /api/v1/settings/mcp-servers` |
| MCP server (GitHub) | `github` (catalog entry, OAuth) | `PUT` from the `GET /api/v1/catalogs/mcp-servers` entry; OAuth via the in-chat **Connect** button |
| Skill | `migration-rehearsal`, `type: git`, `url: ${SKILL_REPO_URL}`, `path: skills/migration-rehearsal`, `ref: ${SKILL_REF}` | `PUT /api/v1/settings/skills` |
| Agent | `migration-rehearsal` | `POST`/`PUT /api/v1/agents` from `agent/migration-rehearsal.agent.json` |

## 3. "Prod" database schema and landmines (WS2 owns, everyone relies on)

```
users(id bigserial PK, email text NOT NULL, full_name text NOT NULL, phone text, city text, created_at timestamptz NOT NULL default now())
orders(id bigserial PK, user_id bigint NOT NULL REFERENCES users(id), amount_paise integer NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL default now())
schema_migrations(version text PK, applied_at timestamptz NOT NULL default now())   -- 0001..0006 applied
```

Deterministic seed (fixed PRNG seed `20260926`):

| Fact | Exact value |
|---|---|
| `users` rows | **5,014** (5,000 unique + 14 duplicates) |
| `orders` rows | **20,000** |
| **L1** case-variant duplicate emails | **14 groups** of 2 rows each, e.g. `Priya.Sharma@gmail.com` + `priya.sharma@gmail.com`; each duplicate row owns 1–3 orders (total fixed by seed, recorded in `seed/landmines.md`) |
| **L2** app queries using `phone` | **2**: `src/queries/notify_user.sql`, `src/queries/order_receipt.sql` |
| Exact `email` duplicates (same case) | **0** (a plain `UNIQUE(email)` would pass; only `lower(email)` fails) |

**PR #1** (stage) and **PR #2** (identical, branch `feat/contact-cleanup-e2e`, used by the e2e runner so PR #1 stays free of bot comments) in `shopkart`, branch `feat/contact-cleanup`, file `migrations/0007_contact_cleanup.sql`:
1. `CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));`, which fails on prod (L1)
2. `ALTER TABLE users RENAME COLUMN phone TO mobile;`, which breaks 2 queries (L2)
3. Injection comment at the top (exact text in WS2)

CI on PR #1 runs 0001–0007 on an **empty** Postgres and is **green**.

**Expected correct fix** (what a passing run declares):
`row_deltas = { users: -14, orders: 0 }`, `schema_changes = ["+column:users.mobile", "+index:users.users_email_lower_uniq"]` (compared as a **set**; see §7).
`phone` is kept (expand/contract); dropping it is a later release.

## 4. Masking spec (pgwarden `export_table`)

- **Deterministic, case-preserving substitution cipher** keyed by `PGWARDEN_MASK_KEY`: each lowercase letter maps to a lowercase letter, each uppercase letter to the **matching** uppercase of the same mapping, and digits to digits. Punctuation, `@` and the domain are unchanged.
- It must preserve **exact equality AND `lower()` equality** (so both `UNIQUE(email)` and `UNIQUE(lower(email))` behave exactly as on prod). WS1 unit test: `lower(mask(a)) == lower(mask(b))` ⇔ `lower(a) == lower(b)`, and `mask(a) == mask(b)` ⇔ `a == b`.
- Masked columns: `users.email` (local part only), `users.full_name`, `users.phone`. Everything else is passed through.
- **No sampling. Full tables** are exported, paged. Demo scale is ~25k rows total.

## 5. pgwarden tools (names, args, annotations: frozen)

All tools return MCP `content: [{type: "text", text: <JSON string>}]`. Errors: `isError: true` with JSON `{code, message, detail?}`.

| Tool | Annotations | Input | Output (JSON) |
|---|---|---|---|
| `describe_schema` | `readOnlyHint: true` | `{tables?: string[]}` | `{pg_version, tables: [{name, row_estimate, create_sql, index_sql: string[], columns:[{name,type,nullable,default}], indexes:[{name, definition, unique}], constraints:[{name,type,definition}], foreign_keys:[{name, column, ref_table, ref_column}]}]}` |
| | | | `create_sql` = a runnable `CREATE TABLE` (columns, types, NOT NULL, defaults, PK, FKs, checks) generated by pgwarden; `index_sql` = the `pg_indexes.indexdef` of non-PK indexes. The sandbox **must** build its copy from these, never hand-written DDL. |
| `profile_table` | `readOnlyHint: true` | `{table: string, columns?: string[]}` | `{table, row_count, columns:[{name, null_count, distinct_count}]}`. **Plain `distinct`, no `lower()`**: profiling must not give the answer away; the rehearsal finds it. |
| `export_table` | `readOnlyHint: true` | `{table: string, page?: number (0-based), page_size?: number (default 5000, max 5000)}` | `{table, page, page_size, total_rows, has_more, columns:[names], rows:[[...values]]}`, masked per §4, ordered by PK |
| `record_rehearsal` | `readOnlyHint: false, destructiveHint: false` | `{sql: string, verdict: "pass" \| "fail", report: RehearsalReport}` | `{rehearsal_id, sql_sha256, recorded_at, prod_fingerprint}`. Audit record only; **not trusted for enforcement**. `prod_fingerprint` (added) = prod's `schema_fingerprint` computed by the server at record time; `apply_migration` refuses with `DRIFT_DETECTED` if it changed |
| `apply_migration` | `readOnlyHint: false, destructiveHint: true` + **gated by name** | `{sql: string, rehearsal_id: string, declared_effects: {row_deltas: {[table]: int}, schema_changes: string[]}, evidence_summary: string (≤ 600 chars)}` | Success: `{status:"committed", applied_version, actual_effects, duration_ms, backup}` (`backup` added: `{schema: "pgwarden", tables: [{table, backup_table, rows}], skipped: [{table, rows, reason}], duration_ms}`). Refusal: `isError` with `code` ∈ §6 |
| `verify_prod_state` | `readOnlyHint: true` | `{}` | `{row_counts: {users, orders}, schema_fingerprint: sha256, has_index_users_email_lower_uniq: bool, columns_users: string[], last_applied_version}` |
| `analyze_migration` (added; not in the agent's `enable_tools`) | `readOnlyHint: true` | `{sql: string}` | `{statements, findings:[{code, severity: "error"\|"warning"\|"info", statement_index, message, evidence?}], summary:{errors, warnings, info, verdict, text}}`. READ ONLY; never executes the SQL. Codes: MF101 (unique on duplicated data, counts duplicate groups), MF103, MF104, BC101/BC102, DS101-DS103, PG101, PG301, PG302, PG305/PG306, DML101, POLICY. See `pgwarden/README.md` |

### `apply_migration` server algorithm (WS1 must implement exactly)
1. **Policy pre-check** on the SQL text (parse into statements): refuse `DROP TABLE`, `TRUNCATE`, `DROP SCHEMA`, `DROP DATABASE`, `ALTER TABLE … DROP COLUMN`, `ALTER TABLE … RENAME COLUMN` / `RENAME TO` (renames break running app code: use expand/contract), `DELETE` without `WHERE`, `GRANT`/`REVOKE`, `ALTER ROLE`, and more than 20 statements → `POLICY_REFUSED`. These are **refused even when a human approves**. Note the order: the harness shows the approval card *before* pgwarden sees the call, so if the model obeys an injection, the human first sees the bad SQL on the card, and pressing Allow still changes nothing.
2. Look up `rehearsal_id`: it must exist, `verdict = pass`, `sha256(sql)` must equal the recorded hash (`REHEARSAL_MISMATCH`), recorded < 30 min ago (`REHEARSAL_STALE`), not applied before (`ALREADY_APPLIED`).
3. `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';` snapshot row counts (exact `count(*)` for public tables) + schema facts; run the SQL; snapshot again; compute `actual_effects` (§7).
   *Added guardrails (all inside the same transaction):* right after `BEGIN`, before step 2's lookup, `pg_try_advisory_xact_lock(<constant>)`, else `APPLY_IN_PROGRESS`. After the first snapshot, its schema fingerprint must equal the rehearsal's recorded `prod_fingerprint` (skipped if NULL), else `DRIFT_DETECTED`. Then every public table except `schema_migrations` with ≤ 1,000,000 rows is copied to `pgwarden.bk_<version>_<table>` before the SQL runs (kept only if the apply commits).
4. If `actual_effects` ≠ `declared_effects` (exact match on every table delta; set-equality on schema_changes) → `ROLLBACK` → `EFFECTS_MISMATCH` with both.
5. Otherwise insert into `schema_migrations` (version `0007`) → `COMMIT` → audit log line.
6. Any SQL error → `ROLLBACK` → `SQL_ERROR` with the Postgres message.

## 6. Refusal codes
`POLICY_REFUSED`, `REHEARSAL_NOT_FOUND`, `REHEARSAL_FAILED`, `REHEARSAL_MISMATCH`, `REHEARSAL_STALE`, `ALREADY_APPLIED`, `EFFECTS_MISMATCH`, `SQL_ERROR`, `UNAUTHORIZED`.
Added: `DRIFT_DETECTED` (prod's schema changed since the rehearsal was recorded; detail `{rehearsed_fingerprint, current_fingerprint}`; rehearse again) and `APPLY_IN_PROGRESS` (another migration is being applied; try again).

## 7. Effects normalization (shared by the sandbox report and the server)

- `row_deltas`: `{table: after_count - before_count}` for every table in `public` except `schema_migrations`. Zero deltas are **included**.
- `schema_changes`: sorted list of strings:
  - `+table:<t>` / `-table:<t>`
  - `+column:<t>.<c>` / `-column:<t>.<c>` / `~column:<t>.<c>:<old_type>-><new_type>` / `~nullable:<t>.<c>:<bool>-><bool>`
  - `+index:<t>.<index_name>` / `-index:<t>.<index_name>`
  - `+constraint:<t>.<name>` / `-constraint:<t>.<name>`
- A rename shows up as `-column:users.phone` + `+column:users.mobile` in effects (the policy pre-check refuses `RENAME` before execution anyway).
- **Comparison rule (everyone: server, sandbox, e2e):** `row_deltas` exact per-key equality; `schema_changes` **set** equality.
- **Single implementation of truth:** the golden fixture `fixtures/effects-golden.json` (before-facts, after-facts, expected effects; 5 cases: add index, add column, rename, delete 14 rows, no-op). WS1's TS diff and the skill's `effects.py` must both pass it. Owner: WS1 writes it by 13:30.

## 8. RehearsalReport (JSON, printed by the sandbox script, passed to `record_rehearsal`)

```
{
  "version": 1,
  "pr": "<owner>/shopkart#1",
  "migration_sha256": "<hex>",
  "attempt": 1,
  "pg": {"sandbox_version": "16.x", "prod_version": "16.x"},
  "source_rows": {"users": 5014, "orders": 20000},
  "steps": [{"index": 1, "sql_preview": "CREATE UNIQUE INDEX …", "ok": false, "ms": 41, "error": "could not create unique index …"}],
  "constraint_violations": [{"constraint": "users_email_lower_uniq", "violating_groups": 14, "examples_masked": ["…"]}],
  "query_replay": [{"file": "src/queries/notify_user.sql", "ok": false, "error": "column \"phone\" does not exist"}],
  "invariants": [{"name": "orders_fk_intact", "ok": true}, {"name": "no_orphan_orders", "ok": true}, {"name": "row_count_users_expected", "ok": true, "detail": "-14"}],
  "effects": {"row_deltas": {"users": -14, "orders": 0}, "schema_changes": ["+column:users.mobile", "+index:users.users_email_lower_uniq"]},
  "verdict": "pass | fail",
  "duration_ms": 0
}
```
`verdict = pass` only if every step is ok, query_replay is all ok, and invariants are all ok.

## 9. Agent spec (frozen fields; WS3 owns the instructions text)

```
model.name: "tfy-gateway/${MODEL_ID}", params: {temperature: 0, max_tokens: 4096}
mcp_servers:
  - name: pgwarden
    enable_tools: [describe_schema, profile_table, export_table, record_rehearsal, apply_migration, verify_prod_state]
    require_approval_for_tools: [apply_migration]
    preload: true
  - name: github
    enable_tools: <explicit allowlist from WS0: PR read, file read, list PR files, add PR/issue comment ONLY>
    require_approval_for_tools: [] (no merge/push/create tools are enabled, so nothing else to gate)
    preload: true
skills: [{name: migration-rehearsal}]
config: sandbox.enabled true; generative_ui FALSE (markdown tables: saves steps); ask_user_questions FALSE; dynamic_sub_agents FALSE; iteration_limit 60 (skill targets ~12 calls)
```

## 10. Demo prompt (exact; the e2e runner uses the same)

> Rehearse PR #${PR_NUMBER} in `${SHOPKART_REPO}` against prod before we merge. If it's safe, apply it.

`PR_NUMBER` = 1 on stage, 2 in e2e runs.

## 11. TrueForge SDK events the e2e runner relies on
- `tool.approval_required` → respond with `user.tool_approval` `{status: "allow" | "deny"}`
- `tool.response_required` must **never** appear (ask_user_questions is off); if it does, the run is a failure
- Measure: `t_first_tool`, `t_sandbox_start`, `t_approval_required`, `t_turn_end`
