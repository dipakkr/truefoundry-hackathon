// node --test viewer/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapEvents, parseToolResult, findReportInText, classifyToolCall } from "../public/mapEvents.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/sample-session.json", import.meta.url), "utf8"));
const byName = (m, re) => m.observations.filter((o) => re.test(o.name));

test("fixture: one TRACE per turn, in chronological order", () => {
  const m = mapEvents(fixture.events); // API order is newest first; the mapper sorts by ULID
  assert.equal(m.traces.length, 2);
  assert.equal(m.traces[0].turnId, fixture.turns[1].id);
  assert.match(m.traces[0].name, /Rehearse PR #1/);
  assert.equal(m.traces[0].meta.required_actions, "tool.approval_required");
  assert.equal(m.observations[0].type, "TRACE");
});

test("fixture: generations carry token usage, MCP tools are named server.tool", () => {
  const m = mapEvents(fixture.events);
  const gens = m.observations.filter((o) => o.type === "GENERATION");
  assert.equal(gens.length, 11);
  assert.ok(gens.every((g) => g.usage && g.usage.input > 0));
  const tools = m.observations.filter((o) => o.type === "TOOL").map((o) => o.name);
  for (const n of ["github.pull_request_read", "github.get_file_contents", "pgwarden.describe_schema", "pgwarden.profile_table", "pgwarden.record_rehearsal", "github.add_issue_comment", "pgwarden.apply_migration", "pgwarden.verify_prod_state"]) assert.ok(tools.includes(n), n);
  assert.equal(m.summary.toolCalls, 11);
  assert.equal(m.summary.tokens, fixture.turns.reduce((s, t) => s + t.state.metrics.total_tokens, 0));
});

test("fixture: sandbox exec -> SPAN; failing run is an error with a RehearsalReport", () => {
  const m = mapEvents(fixture.events);
  const spans = m.observations.filter((o) => o.type === "SPAN");
  assert.equal(spans.length, 2);
  assert.equal(spans[0].status, "bad");
  assert.equal(spans[0].output.exitCode, 1);
  assert.equal(spans[0].report.verdict, "fail");
  assert.equal(spans[1].status, "ok");
  assert.equal(spans[1].report.verdict, "pass");
  assert.deepEqual(spans[0].codeModeCalls.map((c) => c.name).sort(), ["github.get_file_contents", "pgwarden.describe_schema", "pgwarden.export_table"]);
  assert.ok(m.observations.some((o) => o.type === "EVENT" && o.name === "sandbox.created"));
});

test("fixture: RehearsalReports detected from record_rehearsal input and stdout", () => {
  const m = mapEvents(fixture.events);
  assert.equal(m.summary.reports.length, 2);
  assert.deepEqual(m.summary.reports.map((r) => r.report.verdict), ["fail", "pass"]);
  assert.ok(m.summary.reports[1].sources.includes("record_rehearsal input"));
  assert.deepEqual(m.summary.reports[1].report.effects.row_deltas, { users: -14, orders: 0 });
  const rr = byName(m, /^pgwarden\.record_rehearsal$/);
  assert.ok(rr.every((o) => o.report));
});

test("fixture: approval crosses turns; decision allow; apply runs in turn 2", () => {
  const m = mapEvents(fixture.events);
  const appr = m.observations.filter((o) => o.type === "APPROVAL");
  assert.equal(appr.length, 1);
  const a = appr[0];
  assert.equal(a.decision, "allow");
  assert.equal(a.status, "ok");
  assert.equal(a.toolName, "pgwarden.apply_migration");
  assert.equal(a.parentId, m.traces[0].id);
  assert.deepEqual(a.input.v.declared_effects.row_deltas, { users: -14, orders: 0 });
  const apply = byName(m, /^pgwarden\.apply_migration$/)[0];
  assert.equal(apply.parentId, m.traces[1].id);
  assert.equal(apply.meta.tool_call_id, a.meta.tool_call_id);
  assert.equal(apply.status, "ok");
  assert.equal(apply.output.v.status, "committed");
  assert.ok(apply.start >= a.end);
  assert.equal(m.summary.pendingApprovals.length, 0);
});

test("fixture: prod state from verify_prod_state; overall status", () => {
  const m = mapEvents(fixture.events);
  assert.equal(m.summary.prodState.row_counts.users, 5000);
  assert.equal(m.summary.prodState.has_index_users_email_lower_uniq, true);
  assert.equal(m.summary.prodState.last_applied_version, "0007");
  assert.equal(m.summary.status, "applied · verified");
  assert.ok(Math.abs(m.summary.costUsd - fixture.session.metrics.total_cost_in_usd) < 1e-6);
});

test("truncated at the approval: waiting, apply shown as waiting", () => {
  const chrono = fixture.events.slice().reverse();
  const cut = chrono.findIndex((e) => e.event.type === "turn.created" && e.turn_id === fixture.turns[0].id);
  const m = mapEvents(chrono.slice(0, cut));
  assert.equal(m.summary.status, "waiting for approval");
  assert.equal(m.summary.pendingApprovals[0].tool, "pgwarden.apply_migration");
  assert.equal(byName(m, /^pgwarden\.apply_migration$/)[0].status, "wait");
});

test("running turn (no turn.done) reports running", () => {
  const chrono = fixture.events.slice().reverse();
  const i = chrono.findIndex((e) => e.event.type === "sandbox.created");
  const m = mapEvents(chrono.slice(0, i + 1));
  assert.equal(m.summary.running, true);
  assert.equal(m.summary.status, "running");
  assert.equal(m.observations.find((o) => o.type === "SPAN").status, "run");
});

test("deny + POLICY_REFUSED unwrap; user.tool_approval event form", () => {
  const T = "2026-09-26T10:00:0";
  const call = { id: "c1", type: "function", function: { name: "pgwarden_apply_migration", arguments: JSON.stringify({ sql: "DROP TABLE orders;", rehearsal_id: "x" }) }, tool_info: { type: "mcp", server_id: "s", server_name: "pgwarden", name: "apply_migration" } };
  const ev = [
    { turn_id: "t1", event: { type: "turn.created", id: "01aaaaaaaaaaaaaaaaaaaaaaa0", turn_id: "t1", previous_turn_id: null, state: { status: "running" }, created_at: T + "0Z", thread_id: "th", input: [{ type: "user.message", content: "drop orders" }] } },
    { turn_id: "t1", event: { type: "model.message", id: "01aaaaaaaaaaaaaaaaaaaaaaa1", thread_id: "th", created_at: T + "1Z", tool_calls: [call] } },
    { turn_id: "t1", event: { type: "tool.approval_required", id: "01aaaaaaaaaaaaaaaaaaaaaaa2", thread_id: "th", created_at: T + "2Z", tool_calls: [{ id: "c1", source_event_id: "01aaaaaaaaaaaaaaaaaaaaaaa1" }] } },
    { turn_id: "t1", event: { type: "user.tool_approval", id: "01aaaaaaaaaaaaaaaaaaaaaaa3", thread_id: "th", tool_call_id: "c1", approval: { status: "allow" }, created_at: T + "3Z" } },
    { turn_id: "t1", event: { type: "tool.response", id: "01aaaaaaaaaaaaaaaaaaaaaaa4", thread_id: "th", tool_call_id: "c1", created_at: T + "4Z", content: JSON.stringify({ error: [{ type: "text", text: JSON.stringify({ code: "POLICY_REFUSED", message: "DROP TABLE is never applied" }) }] }) } },
    { turn_id: "t1", event: { type: "turn.done", id: "01aaaaaaaaaaaaaaaaaaaaaaa5", thread_id: null, created_at: T + "5Z", state: { status: "done", completed_at: T + "5Z", output: null, required_actions: [] } } },
  ];
  const m = mapEvents(ev);
  const apply = m.observations.find((o) => o.name === "pgwarden.apply_migration");
  assert.equal(apply.status, "bad");
  assert.equal(apply.errorCode, "POLICY_REFUSED");
  assert.equal(m.observations.find((o) => o.type === "APPROVAL").decision, "allow");
  assert.match(m.summary.status, /refused by server \(POLICY_REFUSED\)/);

  const d = parseToolResult(JSON.stringify({ error: "User denied tool call: not today" }), "TOOL");
  assert.equal(d.denied, true);
  assert.equal(d.ok, false);
});

test("helpers: call_tool unwrap, offloaded responses, report in stdout", () => {
  const c = classifyToolCall({ id: "x", type: "function", function: { name: "call_tool", arguments: JSON.stringify({ mcp_server: "pgwarden", tool_name: "verify_prod_state", input: {} }) }, tool_info: { type: "truefoundry-system", name: "call_tool" } });
  assert.equal(c.display, "pgwarden.verify_prod_state");
  const off = parseToolResult("Content too large. Result saved to: /tmp/tool-abc-output.\n\nThe Agent can do...\n\nPreview (first and last 100 chars):\n{...}", "TOOL");
  assert.equal(off.offloaded.path, "/tmp/tool-abc-output");
  assert.equal(findReportInText("log line\n" + JSON.stringify({ version: 1, verdict: "pass", steps: [] }) + "\n").verdict, "pass");
  assert.equal(findReportInText("no report here"), null);
});
