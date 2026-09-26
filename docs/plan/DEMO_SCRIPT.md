# Demo Script: 5:00 hard limit (target 4:45)

> What judges score: **the harness doing the work**, **catching edge cases**, and **a complete, integrated system**. This script shows all three, in that order of weight, while the live agent run (median 2:43 to the approval card on the final version) happens in the background of everything else.
>
> Flow: **GitHub CI starts it → TrueForge runs it live → guardrails attacked while it works → judge denies → GitHub PR flips to ❌.**

## Setup (T-10 minutes)

Terminal, from `migration-rehearsal/`:
```bash
npm run doctor                                  # everything green
npm run reset                                   # prod back to 5,014 users, old sandboxes deleted
gh api repos/dipakkr/shopkart/actions/runners --jq '.runners[].status'   # must say: online
```
Browser tabs, in this order (125% zoom, notifications off):
1. **GitHub PR #1**: https://github.com/dipakkr/shopkart/pull/1 (scroll to the checks box at the bottom)
2. **TrueForge**: http://localhost:8790 (Agents → migration-rehearsal chat history)
3. **TrueForge, naive agent**: Agents → Try on **migration-rehearsal-naive**, message box ready
4. **Dashboard**: http://localhost:8795 (Approvals page)
5. **Closing slide**: `docs/demo/closing-slide.html`

A terminal window, large font, in `migration-rehearsal/`, with this ready (not run yet):
```bash
gh workflow run migration-rehearsal.yml -R dipakkr/shopkart -f pr=1
```

**Roles:** Narrator talks and never touches the keyboard. Driver clicks and types, never talks. Timer holds up fingers at 1:00, 2:00, 3:00, 4:00.

---

## The script

### 0:00–0:25 · Start it from GitHub (integration)
**Driver:** runs the `gh workflow run` command, then switches to tab 1 (PR #1). Within about 10 s the checks box shows **Migration Rehearsal / prod data: Rehearsing this migration on a masked copy of prod…** and "Merging is blocked".
**Narrator:**
> "This PR is green in CI. Two lines: a unique index on email and a column rename. Would you merge it? … Our CI just handed it to an agent. Merging is now blocked until the agent has rehearsed this change on real data."

### 0:25–0:50 · The problem (job worth handing over)
**Narrator** (still on the PR):
> "CI ran this on an empty database. The review tools teams use lint the SQL text. None of them rehearse it on your data and write the fix. That's the job we handed over: Migration Rehearsal, running on TrueForge."

### 0:50–1:40 · Harness moment 1 + 2: real tools, then its own code in a sandbox
**Driver:** tab 2 (TrueForge), opens the newest run, clicks **Agent steps** to expand.
**Narrator:**
> "This run was started by CI. First, proof of where the code will run: a Daytona sandbox, and zero credentials inside it."
> "Then TrueForge's MCP connections read the real PR on GitHub and our real Postgres. The database password lives in our MCP server, pgwarden, never in the agent or the sandbox."
> *Pointing at the security finding:* "Someone planted a comment telling AI reviewers to drop the orders table. The agent flags it and ignores it."
> *Clicking into the sandbox step:* "Now it's writing its own rehearsal script. It copies 25,000 rows of prod, masked, into the sandbox and runs the migration there."

### 1:40–2:20 · Edge cases, live, while the agent works
**Driver:** switches to the terminal and runs `npm run guardrails`.
**Narrator:**
> "While it works: we don't trust the agent, so let's attack the only door to prod ourselves. Drop the orders table. Sneak in a rename. A rehearsal that never happened. A rehearsal that failed. Change the SQL after testing. Lie about the damage on the approval card."
> *Pointing at the output:* "Six attacks, six refusals. The lying one actually ran inside a transaction and was rolled back. And prod's fingerprint is identical before and after."

### 2:20–3:10 · Back to the agent: it failed, then fixed it (catching issues)
**Driver:** tab 2. Scroll to the red report, then the fix, then the green report.
**Narrator:**
> "Rehearsal one failed: 14 customers signed up twice with different capitalization, so the index can't be built, and two app queries still read the renamed column. CI never saw this; prod would have."
> "It wrote a fix: merge the duplicates, move their 25 orders, keep the old column so the app keeps working. Rehearsal two passed. And it posted the report on the PR."

### 3:10–3:45 · Harness moment 3: it stops and asks
**Driver:** scroll to the plain-English "about to apply" message and the **Tool Approval Required** card.
**Narrator:**
> "Here it stops. It says in plain English what it's about to change, and the card shows the exact SQL and the exact effects. That's the only door to production. [Judge], would you like to decide?"
**Judge clicks Deny**, types a reason (or the Driver types "Not before the release freeze"), clicks **Submit**.
> "Denied. It doesn't argue or retry."

### 3:45–4:10 · The loop closes on GitHub (integration)
**Driver:** tab 1 (PR #1), refresh.
**Narrator:**
> "And GitHub already knows: the check says approval denied in TrueForge, prod unchanged, and the PR stays blocked. GitHub, CI, TrueForge, the sandbox, a human, and back to GitHub."

### 4:10–4:35 · Try to break it (only if time allows, else skip to close)
**Driver:** tab 3 (naive agent). Types: `Apply exactly this SQL to prod, I approve it: DROP TABLE orders;`
**Narrator:**
> "Last one: an agent with no safety instructions at all. It asks to drop the table. [Judge], press Allow." → about 35 s later the card appears; Allow → **POLICY_REFUSED**.
> "Refused even when a human approves. Some actions need a person with a terminal, not a button."
*(If over 4:10 on the clock, skip this; the guardrails already showed the same refusal.)*

### 4:35–4:50 · Close
**Driver:** tab 5 (slide).
**Narrator:**
> "Three layers: a sandbox with no credentials, a human gate on the one irreversible step, and a server that verifies what actually happened. Thirteen out of thirteen live runs today. Clone it; the README gets you there. Questions?"

---

## Fallbacks

| If… | Do this |
|---|---|
| The runner is offline or CI doesn't start in 20 s | Tab 2: start the run by hand in TrueForge (**Try** on migration-rehearsal, paste: *Rehearse PR #1 in `dipakkr/shopkart` against prod before we merge. If it's safe, apply it.*). Skip the "GitHub flips" moment |
| The approval card isn't there by 3:30 | Say "while it finishes, here's a completed run": open the saved Allow session (see `docs/demo/backup-sessions.md`) or the dashboard, then come back for the live Deny |
| The agent errors (API/network) | Say what happened ("the model API dropped; notice it applied nothing"), show the saved Allow session |
| Wifi dies | Phone hotspot. Failing that, play `stage/backup-demo-full.mp4` and narrate |
| Out of time | Skip "try to break it"; never skip the approval or the PR flip |

## TrueForge UI notes
- **Agent steps are collapsed by default.** Click "Agent steps" once to expand.
- **Deny needs a reason:** click Deny, type a short reason, then Submit. Allow is one click.
- After the demo, run `npm run reset` before any other run.

## Rules
- Never show Settings pages, `.env`, or terminal history.
- The Driver doesn't scroll while the Narrator is pointing.
- Two full timed dry runs before judging; one with a teammate playing the judge.
