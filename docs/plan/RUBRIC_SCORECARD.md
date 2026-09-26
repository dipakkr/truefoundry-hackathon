# Rubric Scorecard

Every point must be backed by something a judge can **see**, not something we claim. Score ourselves honestly at each checkpoint (14:00, 16:00, 18:00). Anything below "full" gets an owner and a fix before the next checkpoint.

The criteria text is the official wording. "Evidence" is what the judge will see or can check.


## Status (live-verified, 26 Sep 2026)

| Criterion | Status | Evidence |
|---|---|---|
| **30 · Harness** | ✅ | H1: live GitHub + Postgres MCP tool calls in every run. H2: agent writes `/tmp/dr/rehearse.py` and the fix SQL in the Daytona sandbox each run. H3: TrueForge `tool.approval_required` on `apply_migration` in 10/10 runs. H4: Sessions view + trace viewer (`viewer/`) render the real run. H5: live, unscripted, 10/10. |
| **25 · Actually runs** | ✅ | Fresh clone from GitHub + README only → setup all green → doctor clean → full rehearsal committed in 190 s. `setup`, `doctor`, `reset`, `demo-pr`, `e2e` scripts. Reliability 10/10 ([reliability.md](../demo/reliability.md)). AI disclosure in README. |
| **20 · Where it stops** | ✅ | Deny → prod unchanged (5/5). Naive agent `DROP TABLE` + human Allow → `POLICY_REFUSED` (live). Effects mismatch → rollback (pgwarden tests). Policy table in SAFETY.md, README, slide. Plain-English "about to apply" message before the gate. |
| **15 · Job worth handing over** | ✅ | The PR looks harmless with green CI; the agent finds 14 duplicate groups + 2 broken queries and writes the fix (merge dupes, expand/contract). No competitor tests on real data. |
| **10 · Demo clarity** | ✅ (rehearse on stage) | Script retimed to the measured median; live "try to break it"; backup sessions listed in [backup-sessions.md](../demo/backup-sessions.md); closing slide with real numbers; Q&A prep with live findings. |

Still to do by people, not code: two timed dry runs, stage laptop setup (zoom, tabs), and posting the build story after results.

---

## 30 · The harness is doing the work (qualifier)
> "A judge has to watch TrueForge reach a real tool, run generated code in the sandbox, and hold for a person. An agent that is really a prompt with a nice wrapper scores near zero here."

| # | Judge must see | Evidence on stage | Proof it isn't a wrapper | Owner | 14:00 | 16:00 | 18:00 |
|---|---|---|---|---|---|---|---|
| H1 | TrueForge reaches a real tool | Tool cards in **TrueForge chat**: `github.get_pull_request`, `github.get_file_contents`, `pgwarden.describe_schema`, `pgwarden.profile_table`, all against the real repo and the real Neon DB | Right after the run, show the **real PR comment on GitHub** and **prod row counts changing** (Allow path) | WS3 | | | |
| H2 | Runs generated code in the sandbox | Sandbox card with `rehearse_v1.py` **written this run** + its output; a second script after the fix | The fix SQL is different from anything in the repo; the scripts appear in TrueForge's sandbox file downloads | WS3 | | | |
| H3 | Holds for a person | TrueForge's own **Allow / Deny** card on `apply_migration`; **a judge clicks** | Deny path: agent stops, and `verify_prod_state` shows prod untouched | WS1/WS3 | | | |
| H4 | TrueForge is visibly the engine | Narrator names each harness moment out loud ("this is TrueForge's MCP…", "…its Daytona sandbox…", "…its approval gate"); the **Sessions view** at the end: turns, tool calls, sandbox, tokens | Our code is only: pgwarden, a skill, setup scripts. Say this in one sentence. | WS5 | | | |
| H5 | Not a scripted wrapper | Live run, not a video (video is the fallback only); the judge's "try to break it" input is unscripted | e2e reliability number (e.g. 9/10) quoted on the closing slide | WS4 | | | |

**Full marks when:** H1–H3 happen **live in one uninterrupted run** in TrueForge's UI, and H4 is said out loud.

---

## 25 · It actually runs
> "Someone who has never seen the project should be able to clone it, follow the README, and get it going on their own laptop. Narrow scope that works scores above broad scope that doesn't."

| # | Requirement | Evidence | Owner | 14:00 | 16:00 | 18:00 |
|---|---|---|---|---|---|---|
| R1 | Clone → README → working, on a stranger's laptop | Clean-laptop test by a teammate who didn't build it; name, OS and time recorded in the README | WS5 | | | |
| R2 | Minimal prerequisites | 4 accounts (Neon, Daytona, GitHub, one model key); Node 22.14+. Listed on the first screen of the README | WS5 | | | |
| R3 | No manual config clicking | `npm run setup` (registers everything via the TrueForge API), `npm run demo-pr` (creates the demo repo + PR), `npm run doctor` (says what's missing) | WS4 | | | |
| R4 | Works repeatedly | `npm run reset` between runs; e2e ≥ 8/10 runs reach the correct approval card | WS4 | | | |
| R5 | Narrow scope, fully working | One job (rehearse → fix → gate → apply) on Postgres. No half-built extras on stage | Everyone | | | |
| R6 | Proof for judges who won't clone | A 60-second "fresh clone to approval card" screen recording linked at the top of the README | WS5 | | | |
| R7 | Honest disclosure | "AI assistance" section: which tools, what they wrote, what we designed | WS5 | | | |

**Full marks when:** R1 passed before 18:45 and the README's first screen gets a stranger started in under 15 minutes (excluding the Daytona snapshot build).

---

## 20 · Where it stops
> "Which actions did you decide the agent may never take alone, and can you defend the line you drew? We look at what is sandboxed, what is gated, how clearly the agent explains what it is about to do, and how small the damage would be if it got something wrong."

| # | Question in the rubric | Our answer, and where the judge sees it | Owner | 14:00 | 16:00 | 18:00 |
|---|---|---|---|---|---|---|
| S1 | Which actions may it never take alone? | Three-column policy table (Autonomous / Needs a human / Never) on the closing slide, in SAFETY.md and the README | WS5 | | | |
| S2 | Can you defend the line? | One gate on the only irreversible act. Gating reads would train people to click Allow blindly. Some things are refused even when approved, because they need a human with a terminal. | Everyone | | | |
| S3 | What is sandboxed? | All generated code. Masked full copy, no credentials, destroyed with the session. Sidebar line on the slide: "credentials in sandbox: none" | WS3 | | | |
| S4 | What is gated? | `apply_migration`, by name + `destructiveHint`. GitHub tools limited to read + comment | WS1/WS0 | | | |
| S5 | How clearly does it explain what it's about to do? | A plain-English message right before the gate + `evidence_summary` + `declared_effects` on the card | WS3 | | | |
| S6 | How small is the damage if it's wrong? | The server re-checks real effects in a transaction and rolls back on any mismatch. Shown **live** in the "try to break it" segment, plus a backup session of the effects-mismatch case | WS1/WS4 | | | |
| S7 | Prompt injection | Planted in the PR; flagged by the agent, or refused by the server if obeyed | WS2/WS3 | | | |

**Full marks when:** a judge sees a refusal happen (S6) and hears the one-sentence defence of the line (S2).

---

## 15 · A job worth handing over
> "Would a real person actually delegate this, and is it an interesting thing to delegate?"

| # | Evidence | Owner | 14:00 | 16:00 | 18:00 |
|---|---|---|---|---|---|
| J1 | The opening hook: "Who here has had a migration pass CI and fail in prod?" (hands go up) | WS5 | | | |
| J2 | The PR looks harmless and CI is green, so the audience would have merged it too | WS2 | | | |
| J3 | The market gap in one line: existing tools (Atlas, Squawk, Bytebase, PlanetScale) check the SQL text; **none test against production data** | WS5 | | | |
| J4 | Where it fits in real life: runs on every migration PR as a merge-blocking check; the reviewer gets proof instead of a guess | WS5 | | | |

---

## 10 · Demo clarity
> "Five minutes to show the job, the agent doing it, and where the harness fits. Judges will ask you to explain your own architecture."

| # | Evidence | Owner | 14:00 | 16:00 | 18:00 |
|---|---|---|---|---|---|
| D1 | Fits in 5:00 with 20s spare; two timed dry runs | WS5 | | | |
| D2 | One architecture slide with the 3 safety layers and the credential boundary | WS5 | | | |
| D3 | Every teammate can answer the QA_PREP questions in ≤ 30s | Everyone | | | |
| D4 | A fallback for every failure (see DEMO_SCRIPT) | WS5 | | | |

---

## Go / no-go at 18:00
- Any **30-point** row not green → stop polishing; fix it, or prepare the backup session that shows it.
- R1 not passed → the README is the only priority until it is.
- Demo over 5:00 in the dry run → cut the gateway cost segment first, then the Sessions view walk-through (keep one 5-second glance at it).
