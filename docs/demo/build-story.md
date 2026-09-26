# Build story (draft for LinkedIn / X)

Post after results. Tags: #agentsthatact @truefoundry @polariscodes. Attach: docs/demo/approval-card.png, the "POLICY_REFUSED after Allow" screenshot, the architecture diagram, docs/demo/demo-4x.mp4.

---

**Our agent refused to drop a table, even after we clicked Allow.**

At the TrueFoundry × Polaris "Agents That Act" hackathon we built Migration Rehearsal: an agent that tests database migrations on a masked copy of real production data before they're allowed near prod.

The problem: a two-line migration passes CI and code review, then fails in production. CI runs on an empty database; prod has 14 customers who signed up twice with different capitalization. Every migration tool we looked at (Atlas, Squawk, Bytebase, PlanetScale) checks the SQL text. None run it against real data.

What the agent does, on TrueForge:
1. Reads the PR and prod's schema through MCP.
2. Writes its own rehearsal script and runs it in a Daytona sandbox on a masked full copy of prod. No credentials in the sandbox.
3. Finds the failure, writes a fix, rehearses again.
4. Explains in plain English what it's about to do, then stops. Applying to prod needs a human.

Three things we learned:

**1. One gate beats ten.** Only one action is irreversible (applying the migration), so only one action is gated. Gate everything and people click Allow without reading.

**2. Don't trust the agent's report, and don't fully trust the approval either.** Our MCP server re-runs the SQL in a transaction and commits only if the real effects match what the human approved, row for row. A wrong number on the approval card can't turn into a wrong change in prod.

**3. Some things shouldn't be a button.** DROP TABLE, TRUNCATE, renames: the server refuses them even with approval. We tested it with a "naive" agent that has no safety instructions. It tried to drop the orders table, we pressed Allow, and the server said no.

Repo: https://github.com/dipakkr/truefoundry-hackathon

Built with TrueForge, Claude Sonnet 5, Daytona and Postgres. Claude Code helped us write it. It passed 10 of 10 live automated runs.
