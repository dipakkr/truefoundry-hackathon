# Migration Rehearsal: Q&A prep

Answers are meant to be spoken: about 20–30 seconds each. Answer, give one concrete example, stop.

---

## 1. Scope

**Q: What exactly does it do, in one sentence?**
It tests every database migration PR on a masked copy of real production data, fixes what breaks, and applies to prod only after a human approves and the server verifies the exact effects.

**Q: What's in scope today?**
Postgres migrations in GitHub PRs: schema changes and data fixes (constraints, indexes, columns, cleanups). It covers triggering from CI, rehearsal, a fix, a report on the PR, a gated apply, a PR status and a merge gate. Onboarding connects any repo with one command.

**Q: What's out of scope?**
Other databases (MySQL etc.), very large databases (TB scale), rolling back an already-committed migration automatically, and deciding business questions such as "should these 18 double charges be refunded?". The agent grandfathers that data and leaves the decision to humans.

**Q: Why only Postgres?**
The SQL policy uses Postgres's own parser (libpg-query), and the effects engine reads Postgres catalogs. The design (masked export, rehearsal, verified apply) carries over to other databases; the implementation doesn't yet.

**Q: Is this only for the demo app?**
No. Ledgerly was onboarded with the same one command any repo would use. Each project gets its own pgwarden, masking rules, protected tables, agent and CI workflow. The first demo app (shopkart) runs on the same harness.

**Q: Who is the user?**
Platform, DBA and SRE teams, and regulated industries such as fintech, where losing records is a compliance incident.

---

## 2. Edge cases

**Q: What can CI or UAT not catch that you can?**
Failures that depend on production's data: foreign keys and NOT NULL on legacy rows, unique constraints on existing duplicates, cascading deletes, and app queries that break after a schema change.

**Q: Walk me through the ledgerly case.**
A four-line "integrity" PR. It deletes 18 duplicate charges, which cascades into 11 refund records (₹19,554), then fails the foreign key because of 37 orphan payments and 64 without a merchant. Deployed normally, prod is left half-migrated. The agent caught all of it and wrote a fix that changes zero rows.

**Q: What if the migration partially fails?**
pgwarden runs the whole migration in one transaction, so it's all or nothing. A failure rolls back and prod is unchanged. The half-migrated state only happens with the naive deploy.

**Q: What if prod changes between rehearsal and approval?**
`DRIFT_DETECTED`: pgwarden compares prod's schema fingerprint with the rehearsed one and refuses. Rehearsals also expire after 30 minutes (`REHEARSAL_STALE`), and the dashboard shows a countdown.

**Q: What if two migrations are approved at the same time?**
Only one apply runs at a time: the second gets `APPLY_IN_PROGRESS`.

**Q: What if the SQL is changed after rehearsal?**
`REHEARSAL_MISMATCH`: the SQL is hashed, and even a changed comment is refused.

**Q: What about DROP TABLE, TRUNCATE or RENAME?**
Refused by pgwarden's policy (`POLICY_REFUSED`), even if a human approves.

**Q: What about UPDATEs that corrupt values?**
Known limit: our effects count rows and schema, so a wrong value change shows zero row deltas. The review assist flags any UPDATE as "review carefully". Per-column checksums on protected tables are the planned fix.

**Q: Prompt injection?**
PR text and comments are treated as untrusted data. In a real run the agent flagged earlier rehearsal reports in the comments as possible injection and ran its own rehearsal. Even if a model obeyed an injection, the policy refuses destructive SQL.

**Q: PII?**
pgwarden masks PII before data leaves prod: name, email, phone, UPI id and PAN, found by the onboarding scan. The masking is keyed and consistent, so duplicates and joins still behave. The sandbox has zero credentials and the model never sees raw PII.

**Q: Locks on big tables?**
Applies use a 5-second lock timeout and a 30-second statement timeout, so they fail fast instead of hanging prod. `CREATE INDEX CONCURRENTLY` can't run inside a transaction, so it's refused. At scale that needs a separate reviewed path.

---

## 3. Agent behaviour

**Q: Is the flow scripted?**
No. The agent decides every step: which tables to profile, what rehearsal code to write, how to fix. Three runs of the same PR produced three different fixes. The skill gives it rules and a procedure, not a script.

**Q: What if the agent's fix is wrong?**
It happened: one run proposed deleting 119 payments and 11 refunds. The approval card showed exactly that. Protected tables now make pgwarden refuse any loss of payment or refund rows, even after Allow. We don't trust the agent; we verify it.

**Q: Can the agent lie about the effects or fake a rehearsal?**
No. The rehearsal record is only an audit entry. pgwarden re-runs the exact SQL, measures the real effects, and commits only if they equal what was approved. Otherwise it returns `EFFECTS_MISMATCH` and rolls back.

**Q: Can it bypass the human?**
No. The approval gate is a TrueForge harness feature on the tool (`require_approval_for_tools`), not a prompt instruction. TrueForge doesn't execute `apply_migration` until a human decides.

**Q: What if the human denies?**
The agent stops, doesn't retry or rephrase, calls `verify_prod_state` to show prod is unchanged, and the PR check goes red.

**Q: Why does the agent know about protected tables?**
Onboarding writes them into the project agent's instructions, so it aims for a non-destructive fix (`NOT VALID` constraints, re-pointing child rows) instead of learning the rule from a refusal.

**Q: How reliable is it?**
The first demo app went 13 out of 13 end to end. On ledgerly every CI run reached the approval card; fix quality varied. That's why the guarantees live in the server, not the model.

**Q: What's the naive agent for?**
A control agent with no safety instructions that just tries to apply SQL. It proves pgwarden holds on its own: DROP TABLE and lying about effects are refused even with approval.

---

## 4. The loop (one run)

**Q: What happens step by step?**
1. A push → GitHub Actions on a self-hosted runner → `POST /sessions` + a prompt to TrueForge.
2. TrueForge runs the agent: it reads the PR (GitHub MCP) and the schema and profiles (pgwarden).
3. First code run: TrueForge creates a Daytona sandbox, and the agent proves there are zero credentials in it.
4. The agent writes Python that pulls masked prod rows through `call_tool` → TrueForge → pgwarden, loads them into a throwaway Postgres, applies the SQL and measures.
5. v1 fails → the agent writes a fix → v2 passes → `record_rehearsal` → PR comment.
6. The agent calls `apply_migration` → TrueForge pauses the turn and shows the approval card.
7. The human decides → TrueForge resumes → pgwarden verifies and commits (or refuses) → `verify_prod_state`.
8. The CI script, polling events, sets the PR check ✅/❌ and writes the job summary.

**Q: How long does it take, and what does it cost?**
About 3.5–6 minutes from push to approval card, and roughly 50 cents of model usage per run in our tests.

**Q: What stops an infinite loop?**
A 60-step iteration limit per turn, and at most 3 rehearsal attempts per the skill before it reports and stops.

**Q: What if TrueForge or the network fails mid-run?**
The run state is stored in TrueForge. CI status updates retry and never stop the run. If nothing is applied, prod is unchanged; the gate is always the last step.

**Q: Where does the run pause, and for how long?**
At `apply_migration`, for as long as it takes. The pause is durable in TrueForge. After 30 minutes pgwarden treats the rehearsal as stale and a re-run is needed.

---

## 5. Architecture

**Q: What does TrueForge do, and what did you build?**
TrueForge: the agent runtime and model loop, the Code Mode sandbox on Daytona, MCP connections with vaulted tokens, the approval gate with durable pause and resume, the git-pinned skill, and the sessions API. We built the skill, pgwarden, the CI trigger, onboarding and the dashboard. We wrote no agent loop.

**Q: Where are the credentials?**
The prod DB URL lives only in pgwarden. The GitHub and pgwarden tokens are in TrueForge's MCP registry. The sandbox and the model see none of them.

**Q: Why an MCP server (pgwarden) instead of giving the agent DB access?**
So the one irreversible action goes through code that enforces the rules: policy, exact rehearsed SQL, effects match, drift, protected tables, backup. The agent can only ask; pgwarden decides whether it's allowed.

**Q: Why a self-hosted runner?**
So TrueForge and prod never face the internet. The runner only makes outgoing connections to GitHub.

**Q: How does multi-project work?**
One pgwarden per project (its own port, database, masking, protected tables and audit log), registered in TrueForge as `pgwarden-<project>`, plus one agent per project. All of it is set up by `npm run onboard`.

**Q: How is merging controlled?**
Onboarding makes "Migration Rehearsal / prod data" a required check (admins included). PRs without migrations pass in seconds. Migration PRs pass only after they're rehearsed, approved, applied and verified.

**Q: What's the dashboard for?**
A read-only view built on TrueForge's sessions API: runs, traces, approvals with an independent review assist and staleness countdown, and projects with onboarding. Approvals stay in TrueForge.

**Q: What's real vs mocked?**
Everything is real (TrueForge, Claude, Daytona, GitHub PRs and Actions, branch protection, Postgres, masking, applies) except "prod", which is a local database with generated data.

**Q: What would you build next?**
Auto-apply for purely additive changes, per-column checksums for value changes, copy-on-write branches for large databases, and writing the applied fix back to the PR.
