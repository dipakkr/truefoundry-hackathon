# WS0: Spike & Platform (12:00–12:45, hard stop)

**Owner:** Person A (then moves to WS4). **Goal:** remove every platform unknown in 45 minutes so nobody builds on a false assumption.
**Inputs:** PLAN.md, CONTRACTS.md, personal API keys. **Blocked by:** nothing.
**Outputs:** `plan/SPIKE_RESULTS.md` (short, factual) + a message to the team with the four decisions below.

## Tasks (in order)

### S1. TrueForge up (10 min)
- [ ] Node ≥ 22.14 (`node -v`). `npx @truefoundry/trueforge@latest`, open `http://localhost:8790`.
- [ ] Add the model provider: TrueFoundry AI Gateway as **custom** OpenAI-compatible (base URL + key + 2 candidate model ids). Set a **budget limit** on the gateway key.
- [ ] Add Daytona (key with **Snapshots write**). If the release snapshot is still building from last night's prep, keep going with other tasks.

### S2. Model choice (10 min, in parallel with the S3 snapshot wait)
- [ ] Create a scratch agent with sandbox on. Prompt: "write and run a python script that prints 2+2, then call it done".
- [ ] For each candidate: time to first token, whether it calls tools cleanly, whether it follows a 5-step numbered procedure without skipping.
- **Decision 1:** `MODEL_ID`. Prefer the fastest model that follows procedures. Record latency numbers.

### S3. Postgres inside the Daytona sandbox (15 min, the big one)
Try in this order; stop at the first that works **and** boots in < 20s:
1. `pip install pgserver` → start an embedded Postgres in a temp dir → `select version()`.
2. `apt-get install -y postgresql` (needs root + apt network) → `pg_ctl` start.
3. `pip install` a Postgres binary wheel alternative (e.g. `postgresql-wheel`) → start.
4. Node PGlite (`npm i @electric-sql/pglite`) driven from Python via a small node script.
5. **Fallback (no Postgres in sandbox):** add a 7th pgwarden tool `rehearse_on_shadow({sql, queries[]})` that runs on a separate Neon **branch/shadow DB**. The sandbox script still writes and orchestrates the rehearsal via Code Mode. Tell WS1 immediately if we land here.
- [ ] Record: which option, boot time, Postgres major version (compare with Neon's; must match or be within one major version), and whether pip/apt/npm egress works.
- **Decision 2:** the Postgres approach → WS3 (`pg_boot.py`) and WS1 (fallback tool, if needed).

### S4. Code Mode visibility (5 min)
- [ ] Attach any catalog MCP (GitHub) to the scratch agent; ask it to count open PRs **in a script**.
- [ ] Observe how the nested `call_tool` renders: (a) in the Chat UI, (b) in the Sessions view. Screenshot both.
- [ ] Time a Code Mode bulk transfer: a script that calls any tool 5 times with a large response (~1–2 MB each). Record the latency and any payload limit (pgwarden `export_table` will send 5 pages × 5000 rows). If it is slow or capped, tell WS1 to lower `page_size`.
- **Decision 3:** confirm the plan: initial reads as **direct** calls, bulk export via Code Mode. Check whether a gated tool called from Code Mode still shows the Allow/Deny card (docs say yes; verify once with a dummy).

### S5. GitHub tool allowlist (5 min)
- [ ] Connect GitHub (catalog, OAuth). `GET /api/v1/mcp-servers/github/tools` → save the full list with annotations to `plan/github-tools.json`.
- **Decision 4:** exact `enable_tools` names for: get PR, list PR files, get file contents, add a comment to the PR. **Nothing else.** Note which ones (if any) are annotated as write/destructive.

### S6. Approval card check (with S4)
- [ ] Confirm the approval card shows full tool args (long SQL strings, nested objects). If long args get truncated, tell WS3: `evidence_summary` must lead with the key numbers.

## Done when
- `plan/SPIKE_RESULTS.md` has the 4 decisions + timings + screenshots, and the team has been told. **12:45 at the latest; an imperfect decision beats a late one.**

## Pitfalls
- Don't debug Daytona snapshot permissions for more than 10 minutes. Regenerate the key with the right scopes.
- Don't show the Settings pages while anyone records.
