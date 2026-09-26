# Migration Rehearsal

**An agent that tests every database migration PR on a masked copy of real production data, fixes what breaks, and stops for a human before the one step you can't undo.** Built on [TrueForge](https://github.com/truefoundry/trueforge) for the TrueFoundry × Polaris "Agents That Act" hackathon.

> CI said green. Prod lost 11 refunds.

![A real run in the dashboard: TrueForge steps on the left; the approval with review assist ("recommend: allow", zero rows changed) on the right](docs/images/run-trace.png)

## Writeup

*Also as a standalone file: [WRITEUP.md](WRITEUP.md) · [WRITEUP.pdf](WRITEUP.pdf) (2 pages, with dashboard states and edge cases).*

**The problem.** Migrations are tested in CI or on a UAT database, but those don't have production's years of messy history, and migrations break on real data. In our demo app, [ledgerly](https://github.com/dipakkr/ledgerly) (a UPI payments ledger), a four-line PR "Enforce ledger integrity" passes CI. Deployed the usual way, statement by statement, it deletes 18 duplicate charges, **silently cascades into 11 customers' refund records (₹19,554)**, then crashes on statement 3 and leaves prod half-migrated. No test could see it: the bug is in the data, not the code.

**What the agent reaches.** Every PR runs our GitHub workflow, which starts a TrueForge session. The agent reads the PR, pulls a **masked, full copy** of prod into a Daytona sandbox, writes and runs its own rehearsal (applies the SQL, counts violations, replays the app's queries, checks invariants), writes a fix, rehearses again, posts the report on the PR and asks to apply.

**Where it stops.** Applying to prod is gated. TrueForge pauses at `apply_migration` for a human. Our MCP server **pgwarden**, the only holder of the prod credential, then:
- re-runs the exact rehearsed SQL in a transaction and commits only if the real effects equal what the human approved;
- refuses DROP / TRUNCATE / RENAME even with approval;
- refuses when prod drifted, the rehearsal is stale, or the change deletes rows of **protected tables** (payments, refunds).

Merging is blocked until the check is green.

**How TrueForge is used.**
- The agent runtime and model loop.
- The Code Mode sandbox on Daytona, holding **zero credentials** (proven on each run).
- MCP connections with vaulted tokens.
- The human approval gate, with durable pause and resume.
- A git-pinned skill.
- The sessions API, which drives CI status and our trace dashboard.

**Real vs mocked.** Everything runs for real: TrueForge, Claude Sonnet 5, Daytona, GitHub PRs, Actions, statuses and branch protection, Postgres and the applies. Only "prod" is simulated: a local Postgres with generated, deterministic data.

**Known limits.** The agent's fixes vary between runs. Before protected tables existed, two destructive fixes were approved in testing. Effects count rows and schema, not changed values. Full-table copies only suit demo scale. One self-hosted runner means jobs queue.

---

## How it works

![How it works: PR → GitHub Actions → TrueForge (agent, Daytona sandbox, GitHub MCP, pgwarden MCP) → approval card → pgwarden apply → PR check](docs/architecture.svg)

| | Autonomous | Needs a human | Never, even with approval |
|---|---|---|---|
| **What** | Reading the PR and schema, masked export, sandbox rehearsals, fixes, the PR report | `apply_migration` | DROP TABLE, TRUNCATE, DROP/RENAME COLUMN, GRANT/REVOKE, DELETE without WHERE, deleting rows of protected tables, applying SQL that wasn't rehearsed byte for byte |

Threat model and every refusal code: [SAFETY.md](SAFETY.md). Edge cases compared with Atlas, Squawk and Bytebase: [docs/EDGE_CASES.md](docs/EDGE_CASES.md).

### See it

**TrueForge, where the agent runs.** A CI-triggered session of `migration-rehearsal-ledgerly`, paused at the one irreversible step. The run can't continue until a human clicks **Allow** or **Deny**:
![TrueForge approval card: apply_migration awaiting a human, Allow / Deny](docs/images/trueforge-approval.png)

After **Allow**, the agent reports the verified outcome in the same TrueForge session: migration 0007 committed, row counts unchanged, and earlier rehearsal reports in the PR comments treated as untrusted and flagged as a possible injection:
![TrueForge session after approval: applied and verified](docs/images/trueforge-result.png)

**The app.** [ledgerly](https://github.com/dipakkr/ledgerly), a UPI payments ledger with a live ops dashboard (30,055 payments, 427 refunds, 18 double charges).
![ledgerly dashboard](docs/images/ledgerly-ui.png)

**One real run, end to end** (session `01m3ep0n5yeh…`, triggered by a push to ledgerly PR #1). TrueForge ran the agent in this order:
1. sandbox proof;
2. masked export of 30,055 payments;
3. v1 of the PR's SQL fails (37 orphan payments, 64 without a merchant, 18 payments + 11 refunds would be deleted);
4. v2 fix passes with zero row changes;
5. approval, and pgwarden commits 0007 with effects matching exactly.

This is the trace at the top of this page. The **attempts** row reads `attempt 1 fail · payments -18, refunds -11` → `attempt 2 pass · all 0`.

**Projects.** Every onboarded repo with live health, plus onboarding from the UI.
![Projects page](docs/images/projects.png)

### What TrueForge does and what we built

| TrueForge (the harness) | Our code (the domain) |
|---|---|
| Runs the agent: model calls, tool routing, 60-step budget | `skills/migration-rehearsal/`: the procedure and rules, plus sandbox helpers |
| Code Mode sandbox on Daytona; `call_tool` bridge so sandbox code reaches MCP tools without credentials | `pgwarden/`: the MCP server that holds the prod credential, masks PII and gates the apply |
| MCP server registry and token vault (GitHub, pgwarden) | `agent/*.agent.json`: agent spec with `require_approval_for_tools: ["apply_migration"]` |
| Human approval: the pause, the card, and resuming with the decision | `ci/rehearse-pr.mjs`: starts sessions from CI and mirrors them as PR statuses and a job summary |
| Sessions and events API | `viewer/`: read-only trace dashboard, projects, onboarding |

### A product, not a script

- **Onboard any repo** with `npm run onboard -- --project <name> --repo <owner/app>`, or the **Projects** page in the dashboard. The steps:
  1. check the prod database;
  2. **PII scan** that suggests masking;
  3. register the project's own pgwarden and agent in TrueForge (the approval gate is enforced, and it fails closed);
  4. open a PR adding the workflow to the app repo;
  5. make the check **required** on the default branch (admins included);
  6. check the self-hosted runner.
- **Per-project isolation**: each project has its own pgwarden (port, database, masking rules, audit log, protected tables) and its own agent.
- **Review assist** on every approval: a plain-English reading of each statement, risk flags and a recommendation (allow / review / deny), computed from the SQL and effects rather than written by the agent.
- **Dashboard** (`http://localhost:8795`): runs, traces, approvals and projects, with a live trace linked from every PR check.

## Quickstart

**You need:**
- Node 22.14+
- the GitHub CLI (`gh`, logged in) and SSH access to GitHub
- Docker, or any Postgres 16
- a [Daytona](https://daytona.io) API key with `write:sandboxes`, `write:snapshots` and `delete:snapshots`
- one model key: Anthropic, OpenAI, or TrueFoundry AI Gateway

```bash
git clone https://github.com/<you>/truefoundry-hackathon && cd truefoundry-hackathon
cp .env.example .env            # keys, PGWARDEN_TOKEN, PGWARDEN_MASK_KEY, SKILL_REPO_URL + SKILL_REF (a commit SHA)
npm install
docker run -d --name dr-pg -e POSTGRES_PASSWORD=dev -p 55432:5432 postgres:16

# terminal 1: TrueForge on :8790 (allowed to reach MCP servers on localhost)
npm run trueforge
# terminal 2: base setup: model, Daytona sandbox, GitHub MCP, skill (npm run seed + npm run pgwarden first for the bundled demo DB)
npm run setup && npm run doctor
```

**Connect the demo app, ledgerly:**
```bash
git clone https://github.com/<you>/ledgerly ../ledgerly && (cd ../ledgerly && cp .env.example .env && npm install && npm run reset && npm start &)
echo 'LEDGERLY_DATABASE_URL=postgres://postgres:dev@localhost:55432/ledgerly' >> .env
npm run onboard -- --project ledgerly --repo <you>/ledgerly --db-env LEDGERLY_DATABASE_URL
npm run pgwarden:project -- ledgerly     # its own pgwarden on :8788 (masking + protected tables)
npm run onboard -- --project ledgerly    # re-run: every step green; merge the workflow PR it opened
node viewer/server.mjs                   # dashboard on :8795 (Projects page shows health)
```
Register a self-hosted runner for the app repo with the `migration-rehearsal` label (onboarding prints the exact commands). Then open a PR that changes `migrations/`. The check turns yellow, a session appears in TrueForge, and the approval card waits for you.

Reset ledgerly's prod between runs with `cd ../ledgerly && npm run reset`. To see the damage without the harness: `npm run deploy:unsafe -- migrations/0007_….sql` in ledgerly.

## Tested

- **pgwarden:** 61 tests covering golden effects, masking, schema round-trip, drift, deploy lock, backups, every refusal code, and protected tables. **Viewer:** 23 tests (event mapping, dashboard, review assist). Run them with `npm --prefix pgwarden test` and `node --test viewer/test/*.test.mjs`.
- **Live runs:** the first demo app went 13/13 end to end ([docs/demo/reliability.md](docs/demo/reliability.md)). On ledgerly, every CI-triggered run reached the approval card, and the fix quality varied:

  | ledgerly run | Agent's fix | Card | Outcome |
  |---|---|---|---|
  | before protected tables | deleted duplicates, orphans and no-merchant payments | payments −119, refunds −11 | approved in testing, applied exactly as shown |
  | before protected tables | `NOT VALID` constraints, but the duplicate delete still cascaded | payments −18, refunds −11 | approved in testing |
  | **with protected tables** | `NOT VALID` FK and CHECK, partial unique index; flagged old bot comments as possible injection | **all 0** | ✅ applied, PR mergeable |

- `npm run guardrails`: 7 live attacks on pgwarden (lying about effects, swapped SQL, fake or failed rehearsals, DROP TABLE, prod drift), all refused, with prod proven unchanged.

## Repository layout

| Path | What it is |
|---|---|
| `pgwarden/` | TypeScript MCP server (Streamable HTTP, bearer auth): masked export, statement policy, effects engine, gated apply, drift, lock, backups, protected tables, `analyze_migration` |
| `skills/migration-rehearsal/` | Git-backed TrueForge skill: procedure, references, sandbox helpers (`pg_boot.py`, `effects.py`, `sources.py`) |
| `agent/` | Agent specs: `migration-rehearsal` and a `naive` control agent with no safety instructions |
| `projects/` | One config per onboarded app repo |
| `ci/` | `rehearse-pr.mjs` (CI entry) and the workflow template installed by onboarding |
| `scripts/` | `onboard`, `pgwarden:project`, `setup`, `doctor`, `reset`, `guardrails`, `e2e`, `trueforge` |
| `viewer/` | Dashboard: traces, runs, approvals with review assist, projects and onboarding |
| `seed/`, `fixtures/` | The first demo app's data (shopkart) and the golden effects format |
| `docs/` | Contracts, edge cases, plan, demo material |

## Troubleshooting

- **`Outbound URL blocked for host "localhost"`**: start TrueForge with `npm run trueforge`.
- **MCP name rejected**: TrueForge accepts lowercase names with hyphens; onboarding uses `pgwarden-<project>`.
- **Workflow PR fails with 404**: writing `.github/workflows` needs the `workflow` scope through the API; onboarding pushes over SSH instead, so make sure `git@github.com` works.
- **PR check stuck at "expected"**: the app repo's runner is offline or busy. Jobs run one at a time per runner.
- **`REHEARSAL_STALE` after Allow**: approvals must happen within 30 minutes of the rehearsal. Push again to re-rehearse.
- **Numbers don't match**: reset the app's prod (`npm run reset` in ledgerly).

## Licence and AI assistance

MIT. Built with Claude Code (Anthropic): the team designed the idea, architecture, safety model and contracts, and Claude Code helped write the code and docs under that direction.
