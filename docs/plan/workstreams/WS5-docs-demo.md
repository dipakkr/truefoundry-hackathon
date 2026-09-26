# WS5: README, SAFETY.md, architecture, demo, story

**Owner:** Person C from 14:00 (everyone contributes Q&A answers). **Time box:** 14:00–19:30.
**Outputs:** `README.md`, `SAFETY.md`, `docs/architecture.png` (+ source), the rehearsed DEMO_SCRIPT, backup video, build-story post draft, submission write-up.

## T0. Clean-laptop tester (16:00)
- The teammate who will run the clean-laptop test creates their own Neon/Daytona/gateway accounts **at 16:00** and configures Daytona in TrueForge, so the slow first snapshot build is done before 18:15.

## T1. README (draft by 16:30, final after the 18:15 clean-laptop test)
Sections, in order:
1. **What it does** (3 lines + one screenshot of the approval card).
2. **Why:** "CI passed on an empty DB. Prod disagreed." (the 15% "job worth delegating" pitch in 4 lines).
3. **Prerequisites:** Node ≥ 22.14; accounts: Neon, Daytona (key with **Sandboxes + Snapshots write**), TrueFoundry AI Gateway (or any OpenAI-compatible key), GitHub.
4. **Quickstart (copy-paste):** clone → `cp .env.example .env` → fill → `npm i` → `npm run seed` → terminal 1 `npx @truefoundry/trueforge@latest` → terminal 2 `npm run demo` (pgwarden) → `npm run setup` → open `localhost:8790`, pick agent **migration-rehearsal**, click **Connect** for GitHub → paste the demo prompt.
5. **Fork the demo target:** fork `shopkart`, set `SHOPKART_REPO`, open PR #1 from `feat/contact-cleanup` (or use ours).
6. **How it works:** diagram + the 3 safety layers (link SAFETY.md).
7. **Troubleshooting:** Daytona snapshot permission error; OAuth redirect needs `PUBLIC_BASE_URL` if not on localhost; port conflicts; `npm run reset` between runs.
8. **AI assistance disclosure (required):** tools used (e.g. Claude Code), what they wrote vs what we designed, and that we can explain every part of the architecture.
9. **Clean-laptop test:** who, when, OS, time to first approval card.

## T2. SAFETY.md (by 17:00), the "Where it stops" (20%) evidence
- **Open with a three-column policy table** that answers the rubric's exact question ("which actions may the agent never take alone?"): **Autonomous** (all reads, sandbox work, audit record, PR comment) / **Needs a human** (`apply_migration`) / **Never, even with approval** (DROP TABLE, TRUNCATE, DROP or RENAME COLUMN, GRANT/REVOKE, DELETE without WHERE, merging or pushing to the repo). Put the same table on the architecture slide and in the README.
- **Action inventory table:** every tool the agent can reach → read/write/destructive → reversible? → gated? → enforcement layer.
- **Why exactly one gate:** reads are safe; `record_rehearsal` and the PR comment are reversible and audit-only; `apply_migration` is the only irreversible act.
- **Refused even when approved:** DROP TABLE / TRUNCATE / DROP or RENAME COLUMN / GRANT / DELETE without WHERE. Why: some actions need a human with a terminal, not a button. Be precise about the order: the approval card appears *before* pgwarden sees the call, so the human sees the bad SQL, and Allow still changes nothing.
- **Threat model:** prompt injection (live demo), forged rehearsal report (server recomputes effects), masking hides the bug (equality-preserving masking + full copy), credential theft from the sandbox (there are none; Code Mode bridges calls through the harness), runaway loop (`iteration_limit` 40 + gateway budget), lock storms (lock/statement timeouts).
- **Containment:** worst case per component.
- **Known limitations:** the demo-scale full copy (at real scale: Neon branch or a sampled copy with aggregate constraint checks run on prod through a read-only tool); an in-transaction apply locks tables (fine at demo scale; production would use an online-migration tool).

## T2b. 60-second proof video (by 18:45)
- Record the clean-laptop test itself, sped up: `git clone` → `npm run doctor` → `setup` → `demo-pr` → approval card. Link it at the **top** of the README (rubric R6: judges who don't clone still see it runs).

## T3. Architecture image (by 16:30)
One slide: the PLAN.md §2 diagram, redrawn cleanly, with the 3 layers color-coded (sandbox = blue, human gate = amber, server verification = green). Include the sandbox/credential boundary line.

## T4. Demo (see DEMO_SCRIPT.md: 4:40 target, includes the judge "try to break it" segment)
- [ ] 17:00: first full dry run with a timer. 17:15: second. Adjust the narration to fit 3:30.
- [ ] 17:30–18:15: record the backup video (screen + voice, 1080p, no Settings pages, no `.env`). Upload unlisted; link in the README.
- [ ] Prepare the stage laptop: browser zoom 125%, dark/clean profile, notifications off, tabs in order (Chat UI new session, PR #1, backup Deny session, backup Allow session, Sessions view, gateway trace, architecture slide).

## T5. Build story (community prize)
- Collect screenshots all day in `docs/story/` (first failing rehearsal, the approval card, injection caught, the team).
- Draft a LinkedIn/X post: hook ("Our agent refused to drop a table even when we told it to"), 3 lessons, the architecture image, repo link, #agentsthatact @truefoundry @polariscodes. Post after the results.

## Done when
A teammate who didn't build it follows the README on their own laptop to the approval card; the video is uploaded; two dry runs came in ≤ 3:45.
