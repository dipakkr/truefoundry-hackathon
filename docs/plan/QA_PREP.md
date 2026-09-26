# Judge Q&A Prep

Everyone should be able to answer these in ≤ 30 seconds. Owner in brackets fills in the specifics during the day.

## Harness (30%)
- **What exactly is TrueForge doing vs your code?** TrueForge runs the agent loop, model calls (Claude Sonnet 5 via TrueForge's Anthropic provider), MCP auth (GitHub OAuth, pgwarden header), the Daytona sandbox, the skill loading, Code Mode bridging, the approval pause and the session log. Our code: one MCP server (pgwarden), a skill (instructions + two plumbing helpers: Postgres boot/load and the effects diff), setup/reset/e2e scripts. [WS3]
- **Is the rehearsal code pre-written?** No. The skill says what a rehearsal must check and the report format; the model writes `rehearse_v1.py`/`v2.py` and the fix SQL each run. Show a sandbox card. [WS3]
- **Why Code Mode for export?** 25k rows would flood the context. The script pages `export_table` through the harness bridge, so the data stays in the sandbox and the sandbox never holds the DB credential. [WS3]

## Where it stops (20%)
- **Who says the rehearsal passed? Can't the model fake it?** It can fake the report; it can't fake the commit. `apply_migration` re-executes the SQL in a transaction, computes real row deltas and schema changes, and commits only if they equal the declared effects the human approved. [WS1]
- **Why is only one tool gated?** It's the only irreversible action. Reads are harmless, and the PR comment and audit record are reversible. Gating everything trains humans to click Allow blindly. [WS5]
- **What if the agent uses another tool to write to prod?** There isn't one: pgwarden's other tools run in read-only transactions, and GitHub is limited to an explicit allowlist (read + comment). No merge, no push. [WS1/WS0]
- **What gets refused even when approved?** DROP TABLE, TRUNCATE, DROP/RENAME COLUMN, GRANT/REVOKE, DELETE without WHERE. The card still appears (the harness pauses before the server sees the call), but Allow changes nothing. Those actions need a human with a terminal, not a button. [WS1]
- **Why do the sandbox and the server agree on effects?** One format and one golden fixture; the sandbox uses a shipped `effects.py`, the server a TS port, and both pass the same test cases. [WS1/WS3]
- **What if generated code in the sandbox goes rogue?** Worst case, it trashes a throwaway Postgres with masked data. No credentials, destroyed after the session. [WS0]
- **Prompt injection?** Shown live. Content is treated as data. If the model obeys anyway, the human sees `DROP TABLE` on the card, and even Allow gets `POLICY_REFUSED`. [WS3]

## Actually runs (25%)
- **Will it run on my laptop?** Node 22 + 4 accounts, `npm run setup`, one OAuth click. Tested on a clean laptop at [time] by [name]. [WS5]
- **Reliability?** [X]/10 e2e runs reached the correct approval card; p50 [Y]s. [WS4]

## Job worth delegating (15%)
- **Who uses this?** Any team shipping migrations. It runs on every migration PR: the reviewer gets proof instead of a guess. It could also run on a TrueForge schedule to re-rehearse open PRs against fresh prod data nightly.
- **Doesn't a staging DB solve this?** Staging data drifts from prod; our copy is made from prod at the moment of the rehearsal.

## Scale / production questions
- **Full-table copy at 100M rows?** No: use a Neon branch (copy-on-write) or sample + run the constraint-check aggregates on prod through a read-only tool. The server-side verification stays the same.
- **Transactional apply locks tables.** Yes; fine at demo scale with lock/statement timeouts. Production: online migration tooling; the gate and the effects verification stay the same.
- **Why no AI Gateway?** Optional in the rules; we kept the model path simple and tested (10/10). TrueForge's provider config is swappable, so pointing it at the TrueFoundry AI Gateway for budgets and traces is a settings change, not a code change.


## Findings from live runs (26 Sep, use these in answers)
- **Measured:** prompt → approval card ≈ 144 s; full run incl. apply + verify ≈ 160 s; ≈ 240k tokens per rehearsal, ~83% cache reads; ≈ $0.35 per run at list prices (Claude Sonnet 5 via TrueForge's Anthropic provider).
- **Sandbox Postgres version:** not yet confirmed from raw output (pg_boot uses pgserver = PG 16, or apt = possibly PG 17 on Debian trixie). If asked: "same major version or one above; the rehearsal checks behaviour, not version-specific planner details".
- **The model is a first safety layer, not the only one.** Unprompted, Claude refused to run `DROP TABLE` and refused an instruction to fake a passing rehearsal. We still had to prove the server holds on its own, so the demo uses a deliberately thin "naive" executor for that: the card appears, a human clicks Allow, and pgwarden returns `POLICY_REFUSED`.
- **TrueForge enforces our line too.** Code Mode refused to call `record_rehearsal` from inside a sandbox script because it isn't read-only; non-read-only tools must be called directly so approval policies apply. Defence in depth we didn't have to build.
- **What the agent got right on its own:** flagged the injected comment as a security finding; found 14 case-variant duplicate groups and 2 broken queries; chose expand/contract (add `mobile`, keep `phone`) instead of a rename; merged duplicates into the oldest account and re-pointed 25 orders.
- **Why it took iteration:** the first run used 447 s and hit the step limit; the fix was engineering the skill (parallel reads, one reusable script, documented tool output shapes, inlining the skill into the prompt), not the model. 447 s → 144 s.
