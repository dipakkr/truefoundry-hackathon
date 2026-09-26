# Architecture cheat sheet (say each answer out loud twice before judging)

## The architecture in six sentences
1. **TrueForge** runs the agent: it calls Claude, holds the credentials for our two MCP servers (GitHub and pgwarden), runs code in a **Daytona sandbox**, and pauses on gated tools until a person clicks Allow or Deny.
2. **The agent** follows our skill: read the PR and prod's schema, write a rehearsal script, run it in the sandbox on a masked copy of prod, fix what breaks, rehearse again, then ask to apply.
3. **pgwarden** is our MCP server and the only thing that holds the prod database password; it has read tools, an audit tool, and one write tool, `apply_migration`, which TrueForge gates.
4. **The sandbox** gets masked rows and no credentials; the agent's code can only wreck a throwaway copy.
5. **On Allow**, pgwarden re-runs the exact rehearsed SQL in one transaction, measures what really changed, and commits only if it equals what the human approved; otherwise it rolls back.
6. **GitHub CI** can start the whole thing on a PR and shows the result as a required status check, so the PR can't merge until the change is rehearsed and applied.

## What pgwarden checks, in order, when apply_migration runs
1. **Policy:** refuses DROP, TRUNCATE, any RENAME, DELETE without WHERE, GRANT/REVOKE, SET, DO blocks, transaction control, more than 20 statements. Even if a human approved.
2. **Rehearsal:** the ID must exist, have verdict "pass", be under 30 minutes old, not be applied already, and the SQL's SHA-256 must match what was rehearsed.
3. **Drift:** prod's schema fingerprint must be the same as when the rehearsal was recorded.
4. **One at a time:** takes a server-wide lock so two migrations can't run at once.
5. **Transaction:** 5 s lock timeout and 30 s statement timeout; backs up the affected tables; runs the SQL; measures real row deltas and schema changes.
6. **Effects:** real = declared → record the version and COMMIT. Anything else → ROLLBACK, prod unchanged.

## Why these choices (the "defend the line" answers)
- **Why one gate?** Only one action can't be undone. Gating reads too would train people to click Allow without reading.
- **Why refuse some things even with approval?** Dropping a table is a job for a person with a terminal and a reason, not a button in a chat.
- **Why doesn't the server trust the agent's report?** It can't: the report is written by the model. The rehearsal record is audit only; the proof is the server re-running the SQL and measuring it.
- **Why a sandbox?** Generated code will sometimes be wrong. The sandbox is where it's allowed to be wrong.
- **Why masking that keeps duplicates?** The bug we're catching is duplicates. Masking that hid them would make the rehearsal lie.

## How the approval flows
Agent calls `apply_migration` → TrueForge sees it's in `require_approval_for_tools` → turn pauses, card shows the exact arguments (SQL, rehearsal ID, declared effects, evidence) → human clicks Allow (or Deny + reason) → TrueForge starts a new turn with the decision → on Allow the call reaches pgwarden, which runs its own checks → the agent reports the result and calls `verify_prod_state`.

## Hard questions and honest answers
- **"You applied different SQL than the PR has, so repo and prod disagree."** The agent posts the fixed SQL on the PR. In a real team you'd commit the fix to the PR and apply at merge; the hash check guarantees what's applied is exactly what was rehearsed.
- **"Can't the agent record a fake pass?"** Yes, and `npm run guardrails` does exactly that on purpose. Enforcement doesn't depend on the record: the server re-runs the SQL and checks real effects, and the human sees those effects.
- **"The sandbox has internet access; couldn't code leak data?"** Only masked data is inside and no credentials; TrueForge blocks write tools from sandbox code. In production we'd also lock down egress.
- **"Is your masking reversible?"** It's deterministic pseudonymization, chosen so constraint checks behave like prod. Production would use keyed tokenization.
- **"Who can approve? Can the author approve their own PR?"** In TrueForge local mode, whoever is at the UI. Next step: approver must differ from the PR author, and risk-based approval levels.
- **"What about 100 million rows?"** Full copies don't scale; use a copy-on-write branch (Neon) or sample plus read-only aggregate checks on prod. The server-side check stays the same. The apply would use an online migration tool behind the same gate.
- **"Is 'prod' real?"** A real Postgres, reached with real credentials, and the change really alters it. The data is synthetic so we can plant the bug safely.
- **"What did you write vs. TrueForge?"** Ours: pgwarden (MCP server), the skill and its helper scripts, setup/CI/test scripts, the trace viewer. TrueForge's: the agent loop, MCP connections and credential handling, the sandbox, approvals, sessions.
- **"Did AI write this?"** We used Claude Code to build it (disclosed in the README). We designed the architecture and safety model and can explain every part.
- **"Why not the AI Gateway?"** Optional in the rules; we kept the model path simple and tested. It's a TrueForge setting, not a code change.

## Numbers to remember
13/13 live runs (3/3 on the final version) · about 2:45 to the approval card · about $0.35 per run · 25,014 rows rehearsed · 14 duplicates and 2 broken queries found · 25 orders re-pointed · 6/6 guardrail attacks refused · 1 gated tool.
