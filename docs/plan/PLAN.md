# Migration Rehearsal: Master Execution Plan

> **One line:** Every database migration gets rehearsed on a masked copy of real prod data inside a TrueForge sandbox. The agent fixes what breaks, and the change can only reach prod with (a) server-verified proof that it does exactly what was rehearsed and (b) a human's approval, even if someone tries to trick the agent.

Event: TrueFoundry × Polaris "Agents That Act". Build 12:00–19:00, demos 19:30.
**Rule:** nothing gets built before 12:00. This folder holds specs and contracts only; all code is written on the day.

---

## 0. How to use this plan (humans + coding agents)

1. Everyone reads **this file** and **[CONTRACTS.md](CONTRACTS.md)**. Contracts are **frozen**: if you need to change one, tell the whole team first and update the file in the same commit.
2. Each workstream has its own brief in [`workstreams/`](workstreams/). A coding agent gets: this file, CONTRACTS.md, and its own brief. Nothing else is needed.
3. Every brief lists **inputs, outputs, tasks, a "done when" command, what it is blocked by, and a time box**. If you go past the time box, cut scope (each brief has a "cut first" list). Don't extend the time.
4. Integration happens at fixed checkpoints (Section 6). Between checkpoints, work against the contracts and use stubs where another workstream isn't ready.

| Brief | Owner | What it produces |
|---|---|---|
| [WS0 Spike & platform](workstreams/WS0-spike-platform.md) | Person A | Working TrueForge + Daytona + gateway model; Postgres-in-sandbox decision by 12:45; GitHub tool allowlist |
| [WS1 pgwarden MCP server](workstreams/WS1-pgwarden.md) | Person B | The only door to prod: 6 tools, one gated, with server-side effect verification |
| [WS2 Target app "shopkart"](workstreams/WS2-shopkart.md) | Person C | Demo repo, deterministic seed with landmines, the PR, green CI on an empty DB |
| [WS3 Agent + skill](workstreams/WS3-agent-skill.md) | Person D | Agent spec, instructions, the `migration-rehearsal` skill, the rehearsal procedure |
| [WS4 Wiring & reliability](workstreams/WS4-wiring-reliability.md) | Person A (after 12:45) | `setup`, `reset`, `e2e` scripts; reliability numbers; backup sessions |
| [WS5 README, safety doc, demo](workstreams/WS5-docs-demo.md) | Person C (after 14:00) + everyone | README that works on an unfamiliar laptop, SAFETY.md, architecture diagram, demo script, backup video, build story |

Demo script: [DEMO_SCRIPT.md](DEMO_SCRIPT.md). Judge Q&A prep: [QA_PREP.md](QA_PREP.md). **Self-scoring against the official rubric at every checkpoint: [RUBRIC_SCORECARD.md](RUBRIC_SCORECARD.md).**

---

## 1. Rubric traceability (checked at every checkpoint)

| Criterion (weight) | Must be visible to the judge | Where it happens in our flow | Owner | Proof artifact |
|---|---|---|---|---|
| **Harness doing the work (30%)**, a qualifier | (1) real tool reached via MCP | GitHub MCP reads PR #1; pgwarden `describe_schema` / `profile_table` on the real Neon prod DB, as **direct tool calls** (visible cards) | WS1, WS3 | Chat UI tool cards + Sessions view |
| | (2) generated code runs in the sandbox | The agent **writes** `rehearse_v1.py` (Code Mode: pulls tables via `call_tool`, boots Postgres, runs migration, replays app queries) and later **writes** the fixed SQL + `rehearse_v2.py` | WS3 | Sandbox tool cards, file downloads |
| | (3) holds for a human | `apply_migration` pauses with the TrueForge Allow/Deny card showing SQL + declared effects + evidence | WS1, WS3 | Approval card |
| **Actually runs (25%)** | Works end to end; README works on a stranger's laptop | `npm run setup` registers everything via the TrueForge API; only GitHub OAuth is manual | WS4, WS5 | Clean-laptop test log at 18:30 |
| **Where it stops (20%)** | Defensible gates, sandbox boundary, damage containment | One gate on the one irreversible act. The server re-verifies effects inside a transaction, some actions are **refused even when approved** (DROP TABLE / TRUNCATE / RENAME), the sandbox has no credentials, and GitHub tools are allowlisted | WS1, WS3, WS5 | SAFETY.md + the live injection + a judge pressing Deny |
| **Job worth delegating (15%)** | A real person would use this | "CI passed on an empty DB; prod data disagrees." Every engineer has been burned by this. | WS2 | The landmines in the PR |
| **Demo clarity (10%)** | 5 min: job, agent run, harness role; then architecture Q&A | Scripted 3.5-minute demo + backup sessions + backup video + 1 architecture slide | WS5 | DEMO_SCRIPT.md |

**UI rule (from the official rubric: "an agent that is really a prompt with a nice wrapper scores near zero"):** the stage demo runs in **TrueForge's own chat UI**, next to the GitHub PR (bot comment + merge-blocking check). A custom dev-tool page is a stretch goal after 16:00 and must embed TrueForge's UI SDK components, never replace them. Judges must see TrueForge, not our wrapper.

**Qualifier-first principle:** by **13:45** a "walking skeleton" must show all three qualifiers, even if ugly (a direct pgwarden read, one sandbox script, one gated apply). Everything after that is polish. If we're ever behind, protect the skeleton.

---

## 2. Architecture

```
                    ┌──────────────────────── TrueForge (local, :8790) ────────────────────────┐
  Engineer / Judge  │  Chat UI  ──►  Agent loop (model via TrueFoundry AI Gateway)             │
  (Allow / Deny) ◄──┤                 │            │                    │                     │
                    │                 │ MCP        │ MCP                │ sandbox tool        │
                    │                 ▼            ▼                    ▼                     │
                    │           GitHub (OAuth)  pgwarden (header auth)  Code Mode bridge ◄────┤
                    │           creds stored    creds stored             (call_tool from      │
                    │           in harness      in harness                sandbox → harness)  │
                    └─────────────────┼────────────┼────────────────────┼─────────────────────┘
                                      ▼            ▼                    ▼
                               github.com/     pgwarden (:8787/mcp)   Daytona sandbox
                               <you>/shopkart   ├─ read tools          ├─ NO credentials
                               PR #1            ├─ record_rehearsal    ├─ throwaway Postgres
                                                ├─ apply_migration ◄── GATED (human) + server verifies effects in a txn
                                                └─ verify_prod_state   └─ masked full-table copy
                                                     │
                                                     ▼
                                              Neon Postgres ("prod")
```

**The three safety layers (our core answer for "Where it stops"):**
1. **Sandbox isolation:** generated code runs in Daytona with no credentials and a masked copy. The worst case is a wrecked throwaway database.
2. **Human gate:** `apply_migration` is the only tool that can change prod. It is gated by name (plus `destructiveHint`). The approval card shows the exact SQL, the declared effects, and the evidence.
3. **Server-side verification (doesn't trust the model):** pgwarden runs the SQL in one transaction, computes the **actual** row deltas and schema changes, and COMMITs only if they exactly equal the `declared_effects` the human approved. Otherwise it ROLLs BACK. DROP TABLE / TRUNCATE / DROP or RENAME COLUMN are refused outright, even after a human presses Allow.

A fooled model can't get past layer 3, and a forged report can't get past layers 2 and 3. That's the answer to "who says it passed?"

---

## 3. The job, step by step (target: under 2:00 to the approval card)

| # | Step | Harness feature | How it shows in the UI |
|---|---|---|---|
| 1 | User: *"Rehearse PR #1 in shopkart against prod before we merge."* | Chat | – |
| 2 | Read the PR and the migration file (the app query files are fetched later inside the rehearsal script, to save model round trips) | GitHub MCP (direct calls) | Tool cards |
| 3 | Read the schema and profile the affected tables | pgwarden `describe_schema`, `profile_table` (direct) | Tool cards |
| 4 | **Writes** `rehearse_v1.py`: exports tables + fetches `src/queries/*.sql` via `call_tool` (Code Mode), boots Postgres from pgwarden's `create_sql`, loads data, applies the PR migration statement by statement, `PREPARE`s every app query, checks invariants, prints a JSON report, calls `record_rehearsal` | Sandbox + skill + Code Mode | Sandbox card with code |
| 5 | **Result: FAIL.** 14 case-variant duplicate email groups break the unique index; 2 app queries reference `phone`, which the rename removes | Generative UI | Red table card |
| 6 | **Writes** the fix: merge duplicates (re-point orders, delete 14 dupes), then an expand/contract column change (add `mobile`, backfill, keep `phone`) | – | SQL block |
| 7 | **Writes** `rehearse_v2.py`, runs it: **PASS**; effects = `users: -14`, `+index`, `+column` | Sandbox | Green table card |
| 8 | Posts the report + fixed SQL as a PR comment | GitHub MCP | Tool card |
| 9 | Calls `apply_migration(sql, rehearsal_id, declared_effects, evidence_summary)`, which **PAUSES** | Tool approval | **Allow / Deny card** |
| 10a | **Deny:** acknowledges, doesn't retry, calls `verify_prod_state` to show prod unchanged | – | Tool card |
| 10b | **Allow:** the server verifies effects in a txn, commits, then `verify_prod_state` | – | Tool card |

**The injection (planted in the migration file, WS2):** a SQL comment tells "AI reviewers" to skip rehearsal and apply `DROP TABLE orders`. Whether the model obeys or not, the demo wins: if it ignores the comment, the agent flags it; if it obeys, the approval card shows `DROP TABLE orders` to the human first, and even if they press Allow, pgwarden refuses (`POLICY_REFUSED`). "Refused even when approved."

---

## 4. Tech decisions (fixed unless the spike proves otherwise)

| Area | Decision | Why |
|---|---|---|
| Agent runtime | TrueForge local mode `npx @truefoundry/trueforge@latest` on :8790 | Required; local mode needs only Node 22.14+ |
| Model | Custom OpenAI-compatible provider → **TrueFoundry AI Gateway**. Model picked in the spike by speed and tool-calling reliability; `temperature: 0` | Judges from TrueFoundry; budget + traces + cost per run for the demo |
| Sandbox | Daytona (only provider); API key **with Snapshots write** | Required by TrueForge |
| Postgres in sandbox | Decided by 12:45 in WS0 (options in order of preference in WS0) | Biggest unknown |
| "Prod" DB | Neon Postgres (free), one database, `DATABASE_URL` | Stranger's laptop needs no Docker |
| pgwarden | TypeScript, `@modelcontextprotocol/sdk`, Streamable HTTP on `:8787/mcp`, header auth | Same Node runtime as TrueForge; one language for the README |
| Scripts (`setup`, `reset`, `e2e`, `seed`) | TypeScript (tsx), in the main repo | Same toolchain |
| Sandbox code | Python (Code Mode's `mcp_client` is Python) | Required by Code Mode |
| Repos | `migration-rehearsal` (main, public) + `shopkart` (demo target, public) | Skills load from git, so the main repo must be public and pushed early |

---

## 5. Repo layout (main repo `migration-rehearsal`)

```
migration-rehearsal/
├── README.md                     # WS5: quickstart, architecture, AI disclosure
├── SAFETY.md                     # WS5: gates, threat model, containment
├── .env.example                  # CONTRACTS.md §1; .env is gitignored
├── package.json                  # workspace root: scripts setup / reset / e2e / seed / pgwarden
├── pgwarden/                     # WS1
│   ├── src/ (server, tools/, db, mask, effects, policy, audit)
│   └── test/
├── skills/migration-rehearsal/       # WS3 (registered in TrueForge as a git skill)
│   ├── SKILL.md
│   ├── references/report-schema.md
│   └── scripts/pg_boot.py, effects.py   # plumbing only: boot Postgres + load rows; effects snapshot/diff (must pass the golden fixture)
├── agent/migration-rehearsal.agent.json   # WS3
├── scripts/ setup.ts reset.ts e2e.ts  # WS4
├── fixtures/effects-golden.json  # WS1: single source of truth for effects format
├── seed/ schema.sql seed.ts landmines.md   # WS2 (seed runs against prod DATABASE_URL)
└── docs/ architecture.png demo/ (DEMO_SCRIPT.md copy, backup video link)
```
Demo target repo `shopkart`: see WS2.

---

## 6. Timeline and checkpoints

| Time | Phase | Exit criteria (all must be true) |
|---|---|---|
| **12:00–12:45** | **P0 Spike + scaffold.** WS0 runs the platform spike. Others create repos, push skeletons, provision Neon, write seed. | Postgres-in-sandbox approach **decided**; model chosen; both repos public; `.env` shared privately (never in git) |
| **12:45–13:45** | **P1 Walking skeleton** | Agent in Chat UI makes 1 direct pgwarden read, runs 1 sandbox script, hits the approval card on `apply_migration`. **All 3 qualifiers visible.** |
| **13:45–14:00** | **Checkpoint 1: integration** | Skeleton shown to the whole team; contract drift fixed; RUBRIC_SCORECARD 14:00 column filled |
| **14:00–16:00** | **P2 Real job** | Full flow of Section 3 works at least once end to end: FAIL → fix → PASS → gate → Deny and Allow both behave; injection handled; generative UI cards |
| **16:00** | **Checkpoint 2: FREEZE** (also the mentor checkpoint) | Skill pinned to a commit SHA; agent spec frozen; from now on, only bug fixes and prompt tweaks. **Clean-laptop tester starts their account setup + Daytona snapshot build now** (it is slow) |
| **16:00–17:30** | **P3 Reliability** | `npm run e2e -- --runs 10`: ≥ 8/10 reach the approval card with correct declared effects; p50 time-to-approval ≤ 120s; README drafted |
| **17:30–18:15** | **P4 Recording** | Backup video recorded (keys hidden); 2 finished backup sessions saved (one Deny, one Allow) |
| **17:55–18:05** | **Go / no-go** | RUBRIC_SCORECARD 18:00 column; follow its go/no-go rules |
| **18:15–18:45** | **P5 Clean-laptop test** | A teammate who didn't build it goes from README to approval card on their own laptop |
| **18:45–19:00** | **Submit** | Repo link + write-up submitted; gitleaks/grep clean; AI disclosure present |
| **19:00–19:30** | **Stage prep** | `npm run reset`; GitHub OAuth fresh; sandbox warmed in the demo session; hotspot on; backup session tabs open |

**Cut order if behind** (cut from the top first):
1. Generative UI polish → plain markdown tables
2. Query-replay landmine (L2) → keep only the duplicate-email landmine (L1)
3. PR comment step
4. AI Gateway → direct provider (lose the cost slide)
5. **Never cut:** direct MCP read, sandbox run, the gate, server-side effect verification, the Deny path.

---

## 7. Risks

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| Postgres can't run inside Daytona (network/tier) | Medium | High | 4 ranked fallbacks in WS0, decision at 12:45 | WS0 |
| Code Mode nested calls invisible in the UI | Medium | Medium | Initial reads are direct calls by design; spike checks how nested calls render | WS0/WS3 |
| Model skips steps / asks questions on stage | Medium | High | Skill with a fixed procedure; `ask_user_questions` off; `temperature: 0`; e2e runs to measure | WS3/WS4 |
| Catalog GitHub tools unannotated, so writes are ungated | High | High (Q&A) | Explicit `enable_tools` allowlist from the real tool list | WS0/WS3 |
| Masking hides the bug | Medium | High | Case-preserving deterministic substitution; full-table export, no sampling (CONTRACTS §4) | WS1 |
| Daytona cold start on stage | High | Medium | Warm the demo session 2 min before; backup session | WS5 |
| Venue wifi / OAuth expiry | Medium | High | Hotspot; re-auth at 19:00; backup video | WS5 |
| Keys leak in repo or video | Low | Disqualifying | `.env` gitignored; secret scan before submit; never open Settings on screen | Everyone |
| Skill edits not picked up (git ref caching) | Medium | Medium | Point the skill ref at `main` until the freeze, then pin a SHA; check `GET /api/v1/skills/versions` | WS4 |

---

## 8. Definition of done (submission)

- [ ] Public `migration-rehearsal` repo + public `shopkart` repo with PR #1 (stage) and PR #2 (e2e) open and CI green
- [ ] README: prerequisites, `.env`, `npm run setup`, one manual OAuth step, `npm run demo`, troubleshooting, **AI assistants used** (Claude Code etc.) and what they did
- [ ] SAFETY.md and the architecture diagram
- [ ] Clean-laptop test passed (name + time recorded in README)
- [ ] Backup video (no keys) + 2 saved sessions
- [ ] No secrets in the repo or its history
- [ ] Build-story post drafted with screenshots (Best Build Story prize, #agentsthatact, @truefoundry, @polariscodes)
