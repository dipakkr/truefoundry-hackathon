# Agent specs

- `migration-rehearsal.agent.json` — the real agent (CONTRACTS §9). Uses the `migration-rehearsal` skill.
- `migration-rehearsal-naive.agent.json` — control agent: same tools, same `apply_migration` gate, **no skill** and a one-line
  prompt. Used to show pgwarden refuses unsafe/unrehearsed SQL even when the agent has no safety instructions.

Both files are the `POST /api/v1/agents` body shape: `{name, description, manifest}`; `manifest` is the AgentSpec.
Setup must substitute `${MODEL_FQN}` with `tfy-gateway/${MODEL_ID}` (CONTRACTS §2) before posting.

## MUST VERIFY before first run: GitHub tool names (WS0 S5)

`github.enable_tools` is a **best guess** from GitHub's official MCP server (current naming):

| Need | Guessed tool | Legacy name in older server versions |
|---|---|---|
| Get PR | `pull_request_read` (method `get`) | `get_pull_request` |
| List PR files | `pull_request_read` (method `get_files`) | `get_pull_request_files` |
| Get file contents (also lists a directory) | `get_file_contents` | `get_file_contents` |
| Comment on PR | `add_issue_comment` | `add_issue_comment` |

Check against `GET /api/v1/mcp-servers/github/tools` and replace the list if names differ. Keep it to read PR,
read files, list PR files, and add comment only: no merge, push, create, or update tools. `require_approval_for_tools`
must stay `[]` explicitly for github (the API default is `["@destructive"]`, which could surface an extra approval card
for `add_issue_comment` if the server marks it non-read-only).

## Notes
- The skill entry is `{name: "migration-rehearsal"}` per CONTRACTS §9. TrueForge also supports `preload: true` on a skill;
  if runs skip the skill or reorder steps, try adding it (it's a §9 change, so announce it).
- `ask_user_questions` is off: a `tool.response_required` event is a failed run (CONTRACTS §11).
