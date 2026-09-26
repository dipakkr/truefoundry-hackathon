# Migration Rehearsal trace viewer (read-only)

A Langfuse-style view of TrueForge sessions for the `migration-rehearsal` agent. It **shows** the harness's work: turns, model calls, MCP tool calls, sandbox runs, approvals, and prod state. It never replaces the TrueForge chat, and it never sends approvals. The proxy only allows GET, so a POST to `/tf/*` returns 405. Approval cards link to **Decide in TrueForge** (`<TrueForge>/sessions/<id>`).

## Run

```bash
node viewer/server.mjs          # http://localhost:8795
open http://localhost:8795              # live sessions from TrueForge (:8790)
open "http://localhost:8795/?fixture=1" # bundled sample run, no TrueForge needed
```

The viewer has no dependencies and needs Node 18 or newer. It reads these env vars:

- `TRUEFORGE_BASE_URL`: default `http://localhost:8790`.
- `TRUEFORGE_UI_URL`: where the chat links point. Defaults to the base URL.
- `TRUEFORGE_TOKEN`: optional. The proxy forwards it as `Authorization: Bearer`.
- `VIEWER_PORT`: default `8795`.

To run the tests: `node --test viewer/test/*.test.mjs`. To regenerate the fixture: `node viewer/fixtures/make-sample-session.mjs`.

## How it works

- `server.mjs` serves `public/` and `fixtures/`. It proxies `GET /tf/*` to TrueForge, and streams the response body so SSE would pass through as well.
- `public/mapEvents.mjs` is a pure function, `mapEvents(events) -> {observations, traces, summary}`. The browser and the tests share it.
- Data comes from `GET /api/v1/sessions`, `/sessions/{id}`, `/sessions/{id}/turns` and `/sessions/{id}/events`. The events endpoint returns items newest first, so the viewer pages through it with `next_page_token`, and the mapper sorts events by their ULID id.
- **Live mode:** while a turn is running, or while it waits for a human, the trace view polls the session events every 1.5 s. It does not use the SSE `subscribe` endpoint. `model.message.delta` is not persisted, so the viewer only sees complete messages.

| TrueForge event (OpenAPI schema) | Observation |
|---|---|
| `turn.created` (TurnCreatedEvent), `turn.done` (TurnDoneEvent) | **TRACE** per turn. Latency, `state.metrics` tokens and cost, required_actions |
| `model.message` (ModelMessageEvent) | **GENERATION**. `usage.input_tokens/output_tokens`, text, tool calls |
| `tool_calls[]` with `tool_info.type=mcp` (MCPToolInfo) + `tool.response` | **TOOL** `server.tool`. Pgwarden `{"error":[…]}` payloads are unwrapped so the refusal code shows (e.g. `POLICY_REFUSED`) |
| system tool `call_tool` (deferred) | **TOOL** `mcp_server.tool_name` |
| system tool `exec` (TrueFoundrySystemToolInfo) | **SPAN** `sandbox.exec · <intent>`. Shows the exit code and stdout, and lists the Code Mode `call_tool(...)` calls found in the script |
| `tool.approval_required` + `user.tool_approval` (event or next turn's `input`) | **APPROVAL**, waiting or allowed/denied, read-only |
| `sandbox.created`, `mcp.initialize`, `mcp.auth_required`, `tool.response_required`, turn `error`/`cancelled` | **EVENT** |

A RehearsalReport (CONTRACTS §8) is rendered as a table when the viewer finds one. It looks in `pgwarden.record_rehearsal` inputs and in the JSON line that the sandbox script prints. The prod chips come from the latest `pgwarden.verify_prod_state` result.

## Known limits

- **Code Mode calls:** TrueForge does not emit session events for MCP calls made inside a Code Mode script; `CodeModeDispatcher` calls the tool set directly. The viewer lists these calls from the script text on the SPAN. It does not show them as observations of their own.
- **Model prompt:** the full prompt sent to the model is not in the events. A GENERATION's Input tab shows the tool results that arrived since the previous generation.
- **Offloaded responses:** large tool responses that TrueForge moved to the sandbox show as a preview, with a "Download from sandbox" link that uses the turn's `download-sandbox-file` endpoint.
