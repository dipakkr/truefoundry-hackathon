// Pure mapper: TrueForge session events -> Langfuse-style observations.
// No DOM, no fetch. Shared by the browser (app.js) and `node --test`.
//
// Input: an array of SessionEventItem `{turn_id, event}` (GET /api/v1/sessions/{id}/events),
// a ListSessionEventsResponse `{data: [...]}`, or bare SessionEvent objects (turn ids are then
// inferred from `turn.created`). Any order; items are sorted by event id (monotonic ULID).
//
// Schema names used (OpenAPI components/schemas):
//   TurnCreatedEvent        turn.created            -> TRACE (one per turn)
//   ModelMessageEvent       model.message           -> GENERATION (usage -> tokens)
//   ToolCall (MCPToolInfo)  model.message.tool_calls -> TOOL  "server.tool"
//   ToolCall (TrueFoundrySystemToolInfo name=exec)   -> SPAN  sandbox exec (Code Mode)
//   ToolCall (system call_tool)                      -> TOOL  "mcp_server.tool_name" (deferred)
//   ToolResponseEvent       tool.response           -> closes the TOOL/SPAN (paired by tool_call_id)
//   ToolApprovalRequiredEvent tool.approval_required -> APPROVAL (waiting)
//   UserToolApprovalEvent / TurnInputItem user.tool_approval -> APPROVAL decision
//   SandboxCreatedEvent, MCPInitializeEvent, MCPAuthRequiredEvent, ToolResponseRequiredEvent,
//   UserToolApprovalPolicyEvent, ThreadCreated/DoneEvent, TurnDoneEvent(error|cancelled) -> EVENT
//   TurnDoneEvent.state.metrics (TurnMetrics) -> trace tokens / cost

const SYSTEM_DIM = new Set(["list_tools", "get_tool_info", "get_tool_output_schema", "get_current_datetime", "get_openui_instructions"]);

export function parseJson(s) {
  if (typeof s !== "string") return s;
  const t = s.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[" && t[0] !== '"')) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

const ms = (iso) => { const v = Date.parse(iso); return Number.isFinite(v) ? v : null; };

export function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p.text ?? p.refusal ?? "")).join("");
  return String(content);
}

function normalizeItems(input) {
  let arr = Array.isArray(input) ? input : Array.isArray(input?.data) ? input.data : Array.isArray(input?.events) ? input.events : [];
  const items = arr.map((x, i) => (x && x.event && typeof x.event === "object" ? { turn_id: x.turn_id, event: x.event, i } : { turn_id: null, event: x, i }))
    .filter((x) => x.event && typeof x.event.type === "string");
  const ulidish = items.length > 0 && items.every((x) => typeof x.event.id === "string" && /^[0-9a-z]{26}$/i.test(x.event.id));
  items.sort((a, b) => {
    if (ulidish) { const A = a.event.id.toLowerCase(), B = b.event.id.toLowerCase(); if (A !== B) return A < B ? -1 : 1; }
    const ta = ms(a.event.created_at) ?? 0, tb = ms(b.event.created_at) ?? 0;
    return ta - tb || a.i - b.i;
  });
  // infer turn ids for bare events
  let cur = null;
  for (const it of items) {
    if (it.event.type === "turn.created") cur = it.event.turn_id ?? cur;
    if (!it.turn_id) it.turn_id = cur;
    else cur = it.turn_id;
  }
  return items;
}

/** Identify what a tool call is, from ToolCall.tool_info (public or internal shape). */
export function classifyToolCall(tc) {
  const info = tc.tool_info || {};
  const fn = tc.function || {};
  const args = parseJson(fn.arguments) ?? (fn.arguments ? { _raw: fn.arguments } : {});
  const type = info.type || "mcp";
  const name = info.name ?? info.original_tool_name ?? fn.name ?? "tool";
  const server = info.server_name ?? info.mcp_server_name ?? "";
  if (type === "truefoundry-system") {
    if (name === "exec") return { kind: "SPAN", system: name, server: "sandbox", tool: "exec", display: "sandbox.exec" + (args.intent ? " · " + args.intent : ""), args };
    if (name === "call_tool") {
      const s = args.mcp_server || "?", t = args.tool_name || "?";
      return { kind: "TOOL", system: name, server: s, tool: t, display: `${s}.${t}`, args: args.input ?? {}, via: "call_tool (deferred tool)" };
    }
    if (name === "create_sub_agent") return { kind: "SPAN", system: name, server: "system", tool: name, display: "sub_agent · " + (args.name || ""), args };
    return { kind: "TOOL", system: name, server: "system", tool: name, display: `system.${name}`, args, dim: SYSTEM_DIM.has(name) };
  }
  return { kind: "TOOL", system: null, server, tool: name, display: server ? `${server}.${name}` : name, args };
}

/** pgwarden MCP servers: "pgwarden" for the first project, "pgwarden_<project>" for each onboarded one. */
export const isPgwarden = (server) => typeof server === "string" && /^pgwarden(_|$)/.test(server);

/** A RehearsalReport (CONTRACTS.md §8) has version, verdict and steps[]. */
export function isRehearsalReport(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && "verdict" in v && Array.isArray(v.steps) && ("version" in v || "effects" in v);
}

/** Find the last RehearsalReport JSON object printed in a stdout blob. */
export function findReportInText(text) {
  if (typeof text !== "string" || !text.includes("verdict")) return null;
  const whole = parseJson(text);
  if (isRehearsalReport(whole)) return whole;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith("{") && l.includes("verdict")) { const v = parseJson(l); if (isRehearsalReport(v)) return v; }
  }
  // multi-line pretty JSON: try from each "{" at line start, last first
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("{")) { const v = parseJson(lines.slice(i).join("\n")); if (isRehearsalReport(v)) return v; }
  }
  return null;
}

const CODE_MODE_RE = /call_tool\(\s*["']([\w.-]+)["']\s*,\s*["']([\w.-]+)["']/g;
/** MCP calls referenced in a Code Mode script. The harness does not emit events for these. */
export function codeModeCallsInScript(cmd) {
  if (typeof cmd !== "string") return [];
  const seen = new Map();
  for (const m of cmd.matchAll(CODE_MODE_RE)) { const k = `${m[1]}.${m[2]}`; seen.set(k, (seen.get(k) || 0) + 1); }
  return [...seen].map(([name, count]) => ({ name, count }));
}

/** Parse ToolResponseEvent.content into a structured result. */
export function parseToolResult(content, kind) {
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const out = { raw, ok: true, value: undefined, error: null, denied: false, offloaded: null };
  const off = /^Content too large\. Result saved to: (.+?)\.\s*$/m.exec(raw);
  if (raw.startsWith("Content too large.") && off) { out.offloaded = { path: off[1] }; out.value = raw; return out; }
  if (raw.startsWith("Content too big.")) { out.offloaded = { path: null }; out.value = raw; return out; }
  const v = parseJson(raw);
  if (v === undefined) { out.value = raw; return out; }
  if (v && typeof v === "object" && !Array.isArray(v) && "error" in v && Object.keys(v).length === 1) {
    out.ok = false;
    let e = v.error;
    if (Array.isArray(e)) { const txt = e.map((p) => p?.text ?? "").join("\n"); e = parseJson(txt) ?? txt; }
    // TrueForge wraps a denial as {"error":"User denied tool call: <reason>"} inside the error text.
    if (e && typeof e === "object" && !Array.isArray(e) && typeof e.error === "string" && Object.keys(e).length === 1) e = e.error;
    if (typeof e === "string" && e.startsWith("User denied tool call")) out.denied = true;
    out.error = e;
    out.value = e;
    return out;
  }
  if (kind === "SPAN" && v && typeof v === "object" && "success" in v) {
    out.value = v;
    if (v.success === false) { out.ok = false; out.error = v.error ?? "sandbox exec failed"; }
    else {
      out.exitCode = v.response?.exitCode ?? null;
      out.stdout = v.response?.result ?? "";
      if (out.exitCode !== 0 && out.exitCode != null) out.ok = false;
    }
    return out;
  }
  out.value = v;
  if (v && typeof v === "object" && v.isError === true) out.ok = false;
  return out;
}

function errorCode(e) {
  if (e && typeof e === "object" && typeof e.code === "string") return e.code;
  return null;
}

function userMessageText(input) {
  if (!Array.isArray(input)) return "";
  return input.filter((x) => x?.type === "user.message").map((x) => contentText(x.content)).join("\n");
}

/**
 * @returns {{observations: object[], traces: object[], summary: object}}
 */
export function mapEvents(input) {
  const items = normalizeItems(input);
  const obs = [];
  const byId = new Map();
  let seq = 0;
  const traces = new Map(); // turn_id -> TRACE obs
  const calls = new Map(); // tool_call_id -> {obs, cls, turnId, msgId}
  const approvals = new Map(); // tool_call_id -> APPROVAL obs
  const reports = [];
  let prodState = null;
  let lastTs = null, firstTs = null;
  const lastInTurn = new Map(); // turn_id -> last event ms
  let turnNo = 0;

  let curEvId = null;
  const add = (o) => { o.id = o.id ?? (curEvId ? `evt:${curEvId}${o.type === "EVENT" ? "" : ":" + o.type}` : `obs_${seq + 1}`); if (byId.has(o.id)) o.id += `#${seq + 1}`; o.seq = ++seq; o.meta = o.meta || {}; obs.push(o); byId.set(o.id, o); return o; };
  const traceFor = (turnId, t) => {
    if (traces.has(turnId)) return traces.get(turnId);
    turnNo++;
    return traces.set(turnId, add({ id: `trace:${turnId}`, type: "TRACE", name: `turn ${turnNo}`, parentId: null, turnId, start: t, end: null, status: "run", input: null, output: null, meta: { turn_id: turnId }, turnNo })).get(turnId);
  };
  const addReport = (report, source, node, t) => {
    const key = JSON.stringify([report.attempt, report.verdict, report.migration_sha256, report.duration_ms]);
    let r = reports.find((x) => x.key === key);
    if (!r) { r = { key, report, sources: [], t }; reports.push(r); }
    if (!r.sources.includes(source)) r.sources.push(source);
    if (node) node.report = report;
  };
  const decide = (toolCallId, approval, t, turnId, how) => {
    const a = approvals.get(toolCallId);
    if (!a || a.decision) return;
    a.decision = approval?.status || "unknown";
    a.decisionReason = approval?.reason ?? null;
    a.end = t; a.status = a.decision === "allow" ? "ok" : "bad";
    if (a.decision !== "allow") a.meta = { ...(a.meta || {}), denied: true };
    a.output = { decision: a.decision, ...(a.decisionReason ? { reason: a.decisionReason } : {}), decided_at: t ? new Date(t).toISOString() : null, via: how, decided_in_turn: turnId };
    const c = calls.get(toolCallId);
    if (c) { c.decisionAt = t; if (c.obs.end == null) c.obs.status = "run"; }
  };

  for (const { turn_id: turnId, event: ev } of items) {
    curEvId = ev.id ?? null;
    const t = ms(ev.created_at);
    if (t != null) { firstTs = firstTs == null ? t : Math.min(firstTs, t); lastTs = lastTs == null ? t : Math.max(lastTs, t); }
    if (ev.type === "model.message.delta") continue; // streaming only; persisted model.message carries the full content
    const tr = turnId ? traceFor(turnId, t) : null;
    const prev = lastInTurn.get(turnId) ?? t;
    if (tr && t != null && (tr.start == null || t < tr.start)) tr.start = t;

    switch (ev.type) {
      case "turn.created": {
        tr.start = t;
        const msg = userMessageText(ev.input);
        const appr = (ev.input || []).filter((x) => x?.type === "user.tool_approval");
        tr.name = msg ? `turn ${tr.turnNo} · ${msg.replace(/\s+/g, " ").slice(0, 60)}` : appr.length ? `turn ${tr.turnNo} · approval resume` : `turn ${tr.turnNo}`;
        tr.input = msg ? { kind: "text", v: msg } : { kind: "json", v: ev.input ?? [] };
        tr.meta.previous_turn_id = ev.previous_turn_id ?? null;
        for (const a of appr) decide(a.tool_call_id, a.approval, t, turnId, "turn.created.input (user.tool_approval)");
        break;
      }
      case "turn.update": {
        const st = ev.state?.status;
        tr.status = st === "paused" ? "wait" : "run";
        if (st === "paused") tr.meta.paused_on = (ev.state.action_required_on_events || []).map((x) => x.id).join(", ");
        break;
      }
      case "turn.done": {
        const s = ev.state || {};
        tr.end = ms(s.completed_at) ?? t;
        tr.meta.turn_status = s.status;
        if (s.metrics) tr.metrics = s.metrics;
        if (s.status === "done") {
          const pending = (s.required_actions || []).length;
          tr.status = "ok";
          tr.requiredActions = s.required_actions || [];
          if (pending) tr.meta.required_actions = s.required_actions.map((x) => x.type).join(", ");
          if (s.output) tr.output = { kind: "text", v: contentText(s.output.content) || "(no final text)" };
        } else if (s.status === "error") {
          tr.status = "bad";
          add({ type: "EVENT", name: "turn.error", parentId: tr.id, turnId, start: t, end: t, status: "bad", input: null, output: { kind: "text", v: s.message || "error" }, meta: {} });
        } else if (s.status === "cancelled") {
          tr.status = "bad";
          add({ type: "EVENT", name: `turn.cancelled · ${s.reason || ""}`, parentId: tr.id, turnId, start: t, end: t, status: "bad", input: null, output: { kind: "json", v: s }, meta: {} });
        }
        break;
      }
      case "model.message": {
        const u = ev.usage || null;
        const text = contentText(ev.content);
        const tcs = Array.isArray(ev.tool_calls) ? ev.tool_calls : [];
        const classes = tcs.map(classifyToolCall);
        const label = classes.length ? "→ " + classes.map((c) => c.display.split(" · ")[0]).join(", ") : "reply";
        const g = add({
          id: `gen:${ev.id}`, type: "GENERATION", name: `llm ${label}`, parentId: tr?.id ?? null, turnId, start: prev, end: t, status: ev.refusal ? "bad" : "ok",
          input: null,
          output: { kind: "generation", text, reasoning: ev.reasoning_content || "", tool_calls: tcs.map((tc, i) => ({ id: tc.id, name: classes[i].display, arguments: classes[i].args })) },
          meta: { event_id: ev.id, thread_id: ev.thread_id, finish_reason: ev.finish_reason ?? null, ...(ev.name ? { name: ev.name } : {}) },
          usage: u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cache_read_tokens ?? 0, breakdown: u.input_tokens_breakdown ?? null } : null,
        });
        // context that fed this generation: tool results since the previous generation in the turn
        g.input = { kind: "context", items: (tr?._ctx || []).slice() };
        if (tr) tr._ctx = [];
        tcs.forEach((tc, i) => {
          const c = classes[i];
          const node = add({
            id: `call:${tc.id}`, type: c.kind, name: c.display, parentId: tr?.id ?? null, turnId, start: t, end: null, status: "run",
            input: { kind: c.kind === "SPAN" ? "exec" : "json", v: c.args },
            output: null,
            meta: { tool_call_id: tc.id, source_event_id: ev.id, ...(c.via ? { via: c.via } : {}), ...(c.system ? { system_tool: c.system } : { server: c.server }) },
            dim: !!c.dim,
          });
          if (c.kind === "SPAN" && c.system === "exec") node.codeModeCalls = codeModeCallsInScript(c.args.command);
          if (isPgwarden(c.server) && c.tool === "record_rehearsal" && isRehearsalReport(c.args.report)) addReport(c.args.report, "record_rehearsal input", node, t);
          calls.set(tc.id, { obs: node, cls: c, turnId, msgId: ev.id, t });
        });
        break;
      }
      case "tool.response": {
        const c = calls.get(ev.tool_call_id);
        if (!c) {
          add({ type: "EVENT", name: "tool.response (unmatched)", parentId: tr?.id ?? null, turnId, start: t, end: t, status: "bad", input: null, output: { kind: "text", v: ev.content }, meta: { tool_call_id: ev.tool_call_id } });
          break;
        }
        const n = c.obs;
        if (c.turnId !== turnId && tr) {
          // gated call resumed in a later turn: execution happens here, after the human decision
          n.parentId = tr.id; n.turnId = turnId; n.start = c.decisionAt ?? tr.start ?? t; n.seq = ++seq;
          n.meta.called_in_turn = c.turnId;
        }
        const r = parseToolResult(ev.content, c.cls.kind);
        n.end = t;
        n.result = r;
        n.status = r.ok ? "ok" : "bad";
        n.meta.response_event_id = ev.id;
        if (r.denied) { n.status = "bad"; n.meta.denied = true; }
        const code = errorCode(r.error);
        if (code) { n.errorCode = code; n.meta.error_code = code; }
        if (r.offloaded) n.meta.offloaded_to = r.offloaded.path || "(sandbox output truncated)";
        n.output = r.offloaded ? { kind: "text", v: r.raw } : c.cls.kind === "SPAN" && r.stdout != null ? { kind: "exec", exitCode: r.exitCode, stdout: r.stdout } : r.ok ? (typeof r.value === "string" ? { kind: "text", v: r.value } : { kind: "json", v: r.value }) : { kind: "error", v: r.error, code };
        if (c.cls.kind === "SPAN") {
          const rep = findReportInText(r.stdout);
          if (rep) addReport(rep, "sandbox stdout", n, t);
        }
        if (isPgwarden(c.cls.server)) {
          if (c.cls.tool === "verify_prod_state" && r.ok && r.value && typeof r.value === "object") prodState = { ...r.value, at: t, obsId: n.id };
          if (c.cls.tool === "apply_migration") n.applyResult = r.ok ? { status: r.value?.status ?? "ok", applied_version: r.value?.applied_version } : { status: r.denied ? "denied" : "refused", code };
        }
        if (tr) (tr._ctx = tr._ctx || []).push({ name: n.name, ok: n.status === "ok", preview: r.raw.slice(0, 280) });
        break;
      }
      case "tool.approval_required": {
        for (const ref of ev.tool_calls || []) {
          const c = calls.get(ref.id);
          const args = c?.cls.args ?? {};
          const a = add({
            id: `appr:${ref.id}`, type: "APPROVAL", name: `approval · ${c?.cls.display ?? ref.id}`, parentId: tr?.id ?? null, turnId, start: t, end: null, status: "wait",
            input: { kind: "json", v: args }, output: null,
            meta: { tool_call_id: ref.id, source_event_id: ref.source_event_id, gate: "require_approval_for_tools", event_id: ev.id },
            toolName: c?.cls.display ?? null, decision: null,
          });
          approvals.set(ref.id, a);
          if (c) { c.obs.status = "wait"; c.obs.meta.awaiting_approval = true; c.gated = true; }
        }
        break;
      }
      case "user.tool_approval":
        decide(ev.tool_call_id, ev.approval, t, turnId, "user.tool_approval event");
        break;
      case "user.tool_approval_policy":
        add({ type: "EVENT", name: "user.tool_approval_policy", parentId: tr?.id ?? null, turnId, start: t, end: t, status: "ok", input: null, output: { kind: "json", v: ev.policies }, meta: {} });
        break;
      case "sandbox.created":
        add({ type: "EVENT", name: "sandbox.created", parentId: tr?.id ?? null, turnId, start: t, end: t, status: "ok", input: null, output: { kind: "json", v: { sandbox_id: ev.sandbox_id } }, meta: { sandbox_id: ev.sandbox_id } });
        break;
      case "mcp.initialize":
        add({ type: "EVENT", name: "mcp.initialize · " + (ev.mcp_servers || []).map((s) => s.name).join(", "), parentId: tr?.id ?? null, turnId, start: t, end: t, status: "ok", input: null, output: { kind: "json", v: ev.mcp_servers }, meta: {} });
        break;
      case "mcp.auth_required":
        add({ type: "EVENT", name: "mcp.auth_required · " + (ev.mcp_servers || []).map((s) => s.name ?? s.server_name ?? "?").join(", "), parentId: tr?.id ?? null, turnId, start: t, end: t, status: "wait", input: null, output: { kind: "json", v: ev.mcp_servers }, meta: {} });
        break;
      case "tool.response_required":
        add({ type: "EVENT", name: "tool.response_required (ask_user_questions should be off)", parentId: tr?.id ?? null, turnId, start: t, end: t, status: "bad", input: null, output: { kind: "json", v: ev.tool_calls }, meta: {} });
        break;
      case "thread.created":
        add({ type: "EVENT", name: "thread.created · " + (ev.agent_info?.name ?? ev.thread_id), parentId: tr?.id ?? null, turnId, start: t, end: t, status: "ok", input: { kind: "text", v: ev.agent_info?.input ?? "" }, output: null, meta: { thread_id: ev.thread_id } });
        break;
      case "thread.done":
        add({ type: "EVENT", name: "thread.done · " + (ev.state?.status ?? ""), parentId: tr?.id ?? null, turnId, start: t, end: t, status: ev.state?.status === "error" ? "bad" : "ok", input: null, output: { kind: "json", v: ev.state }, meta: { thread_id: ev.thread_id } });
        break;
      default:
        add({ type: "EVENT", name: ev.type, parentId: tr?.id ?? null, turnId, start: t, end: t, status: "ok", input: null, output: { kind: "json", v: ev }, meta: {} });
    }
    if (turnId && t != null) lastInTurn.set(turnId, t);
  }

  // close out: calls with no response
  for (const c of calls.values()) {
    const n = c.obs;
    if (n.end != null) continue;
    const tr = traces.get(n.turnId);
    if (c.gated) n.status = "wait";
    else if (tr && tr.end != null) { n.status = "bad"; n.meta.note = "no tool.response recorded"; }
  }
  for (const tr of traces.values()) delete tr._ctx;

  // order: tree walk, children by start then seq
  const kids = new Map();
  for (const o of obs) { const k = o.parentId ?? "__root"; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(o); }
  for (const list of kids.values()) list.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.seq - b.seq);
  const ordered = [];
  const walk = (pid, level) => { for (const o of kids.get(pid) || []) { o.level = level; ordered.push(o); walk(o.id, level + 1); } };
  walk("__root", 0);

  // summary
  const traceList = ordered.filter((o) => o.type === "TRACE");
  const gens = obs.filter((o) => o.type === "GENERATION");
  const tokIn = gens.reduce((s, g) => s + (g.usage?.input || 0), 0);
  const tokOut = gens.reduce((s, g) => s + (g.usage?.output || 0), 0);
  let metricTokens = 0, cost = 0, haveCost = false;
  for (const tr of traceList) {
    const m = tr.metrics; if (!m) continue;
    metricTokens += m.total_tokens ?? ((m.total_input_tokens || 0) + (m.total_output_tokens || 0));
    if (typeof m.total_cost_in_usd === "number") { cost += m.total_cost_in_usd; haveCost = true; }
    tr.tokens = m.total_tokens ?? ((m.total_input_tokens || 0) + (m.total_output_tokens || 0));
  }
  for (const tr of traceList) if (tr.tokens == null) tr.tokens = gens.filter((g) => g.parentId === tr.id).reduce((s, g) => s + (g.usage?.input || 0) + (g.usage?.output || 0), 0);
  const toolObs = obs.filter((o) => (o.type === "TOOL" || o.type === "SPAN") && !o.dim);
  const pendingApprovals = obs.filter((o) => o.type === "APPROVAL" && !o.decision);
  const applies = obs.filter((o) => o.applyResult);
  const lastApply = applies[applies.length - 1];
  const running = traceList.some((tr) => tr.end == null);
  const lastTrace = traceList[traceList.length - 1];
  const verifiedAfterApply = lastApply && prodState && prodState.at >= (lastApply.end ?? 0);

  let status = "done", statusClass = "ok";
  if (pendingApprovals.length) { status = "waiting for approval"; statusClass = "warn"; }
  else if (running) { status = lastTrace?.status === "wait" ? "paused" : "running"; statusClass = lastTrace?.status === "wait" ? "warn" : "run"; }
  else if (lastApply?.applyResult.status === "committed") { status = verifiedAfterApply ? "applied · verified" : "applied"; statusClass = "ok"; }
  else if (lastApply?.applyResult.status === "denied") { status = "denied · prod unchanged"; statusClass = "bad"; }
  else if (lastApply) { status = `refused by server${lastApply.applyResult.code ? " (" + lastApply.applyResult.code + ")" : ""}`; statusClass = "bad"; }
  else if (lastTrace?.status === "bad") { status = "error"; statusClass = "bad"; }
  else if (!traceList.length) { status = "no events"; statusClass = "idle"; }

  return {
    observations: ordered,
    traces: traceList,
    summary: {
      status, statusClass, running,
      turns: traceList.length,
      toolCalls: toolObs.length,
      tokens: metricTokens || tokIn + tokOut,
      tokensIn: tokIn, tokensOut: tokOut,
      costUsd: haveCost ? cost : null,
      firstTs, lastTs,
      durationMs: firstTs != null && lastTs != null ? lastTs - firstTs : null,
      pendingApprovals: pendingApprovals.map((a) => ({ id: a.id, tool: a.toolName, tool_call_id: a.meta.tool_call_id })),
      reports: reports.map((r) => ({ report: r.report, sources: r.sources, at: r.t })),
      prodState,
      lastTurnId: lastTrace?.turnId ?? null,
    },
  };
}
