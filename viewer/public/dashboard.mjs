// Pure dashboard helpers: mapped sessions -> table rows, KPIs, chart series, approvals.
// No DOM, no fetch. Shared by the browser (app.js) and `node --test`.

export const REHEARSAL_AGENT = "migration-rehearsal";
/** Migration Rehearsal agents: "migration-rehearsal" and one "migration-rehearsal-<project>" per onboarded project (not the naive control). */
export const isRunAgent = (name) => typeof name === "string" && (name === REHEARSAL_AGENT || (name.startsWith(REHEARSAL_AGENT + "-") && name !== REHEARSAL_AGENT + "-naive"));
export const DEFAULT_REPO = "dipakkr/shopkart";
const HOUR = 3600e3;

/** Outcome buckets shown as status pills. Order is the legend / stack order. */
export const OUTCOMES = [
  { key: "applied", label: "applied", cls: "ok" },
  { key: "denied", label: "denied", cls: "bad" },
  { key: "refused", label: "refused", cls: "refused" },
  { key: "waiting", label: "waiting", cls: "warn" },
  { key: "running", label: "running", cls: "run" },
  { key: "error", label: "error", cls: "err" },
  { key: "noapply", label: "no apply", cls: "idle" },
];
const OUT = Object.fromEntries(OUTCOMES.map((o) => [o.key, o]));

/** Map mapEvents().summary.status to a pill bucket. */
export function outcomeOf(summary) {
  const s = String(summary?.status || "");
  let key;
  if (s.startsWith("applied")) key = "applied";
  else if (s.startsWith("denied")) key = "denied";
  else if (s.startsWith("refused")) key = "refused";
  else if (s.startsWith("waiting") || s === "paused") key = "waiting";
  else if (s === "running") key = "running";
  else if (s === "error") key = "error";
  else key = "noapply";
  const o = OUT[key];
  // keep the specific text ("applied · verified", "refused by server (CODE)") as the pill label
  const label = key === "applied" ? s : key === "refused" ? "refused" : key === "denied" ? "denied" : key === "waiting" ? "waiting" : o.label;
  const code = key === "refused" ? (/\(([^)]+)\)/.exec(s)?.[1] ?? null) : null;
  return { key, label, cls: o.cls, code, full: s };
}

/** Repo + PR number from a prompt like "Rehearse PR #2 in `dipakkr/shopkart` against prod". */
export function repoPrFromText(text) {
  const t = String(text || "");
  const repo = /`([\w.-]+\/[\w.-]+)`/.exec(t)?.[1] ?? /\b(?:in|repo)\s+([\w.-]+\/[\w.-]+)/i.exec(t)?.[1] ?? null;
  const pr = /\bPR\s*#?(\d+)/i.exec(t)?.[1] ?? /\/pull\/(\d+)/.exec(t)?.[1] ?? null;
  return { repo, pr: pr ? Number(pr) : null, url: repo && pr ? `https://github.com/${repo}/pull/${pr}` : null };
}

export function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * One table row per session.
 * @param session TrueForge Session (GET /api/v1/sessions item)
 * @param mapped  mapEvents(events) result
 */
export function sessionRow(session, mapped) {
  const s = mapped.summary;
  const obs = mapped.observations;
  const prompt = session.title || mapped.traces[0]?.input?.v || "";
  const approvals = obs.filter((o) => o.type === "APPROVAL").map((a) => {
    const call = obs.find((o) => o.id === `call:${a.meta.tool_call_id}`);
    let result = null;
    if (call && call.end != null) {
      if (call.applyResult) result = { status: call.applyResult.status, code: call.applyResult.code ?? null };
      else result = { status: call.status === "ok" ? "ok" : call.meta?.denied ? "denied" : "error", code: call.errorCode ?? null };
    }
    return {
      id: a.id, sessionId: session.id, tool: a.toolName, decision: a.decision || "pending", reason: a.decisionReason ?? null,
      requestedAt: a.start, decidedAt: a.decision ? a.end : null, waitMs: a.decision && a.end != null && a.start != null ? a.end - a.start : null,
      // agent working time: from the start of the turn that asked, to the approval card appearing
      cardMs: (() => { const tr = obs.find((o) => o.id === a.parentId); return tr?.start != null && a.start != null ? a.start - tr.start : null; })(),
      result,
    };
  });
  const decided = approvals.filter((a) => a.waitMs != null);
  const agent = session.agent?.name ?? (session.agent?.type === "inline" ? "inline" : session.agent ? "inline" : "–");
  return {
    id: session.id,
    createdAt: Date.parse(session.created_at) || s.firstTs || null,
    updatedAt: session.updated_at ?? null,
    prompt: String(prompt).replace(/\s+/g, " ").trim(),
    agent,
    isRehearsal: isRunAgent(session.agent?.name),
    outcome: outcomeOf(s),
    // harness time (excludes the human wait between turns); fall back to wall clock
    latencyMs: session.metrics?.total_duration_ms || s.durationMs || null,
    turns: session.metrics?.total_turns ?? s.turns,
    ttaMs: (approvals.find((a) => a.cardMs != null) || {}).cardMs ?? null,
    pending: approvals.filter((a) => a.decision === "pending").length,
    tokens: s.tokens || 0,
    costUsd: session.metrics?.total_cost_in_usd ?? s.costUsd ?? null,
    toolCalls: s.toolCalls,
    sandboxRuns: obs.filter((o) => o.type === "SPAN" && o.meta?.system_tool === "exec").length,
    approvals,
    ...repoPrFromText(prompt),
  };
}

/** Start of the local clock hour containing t (timezones with :30 offsets bucket on local hours). */
export const floorHour = (t) => { const d = new Date(t); d.setMinutes(0, 0, 0); return d.getTime(); };

/**
 * KPIs and chart series over rehearsal runs (agent === "migration-rehearsal").
 * The hour axis spans at least `minHours` back from now (so one busy hour isn't one fat bar)
 * and at most `maxHours`.
 */
export function aggregate(rows, { now = Date.now(), minHours = 6, maxHours = 24 } = {}) {
  const runs = rows.filter((r) => r.isRehearsal);
  const count = (k) => runs.filter((r) => r.outcome.key === k).length;
  const decided = runs.flatMap((r) => r.approvals.filter((a) => a.waitMs != null).map((a) => ({ ...a, run: r })));
  const kpis = {
    runs: runs.length,
    applied: count("applied"),
    denied: count("denied"),
    refused: count("refused"),
    error: count("error"),
    noapply: count("noapply"),
    pendingApprovals: runs.reduce((n, r) => n + r.pending, 0),
    medianTtaMs: median(runs.map((r) => r.ttaMs).filter((v) => v != null)),
    ttaN: runs.filter((r) => r.ttaMs != null).length,
    tokens: runs.reduce((n, r) => n + (r.tokens || 0), 0),
  };

  const end = floorHour(now);
  const first = runs.reduce((m, r) => (r.createdAt != null && r.createdAt < m ? r.createdAt : m), now);
  let start = floorHour(Math.min(first, now - (minHours - 1) * HOUR));
  start = Math.max(start, end - (maxHours - 1) * HOUR);
  const hours = [];
  for (let t = start; t <= end; t = floorHour(t + HOUR + 60e3)) hours.push({ t, counts: Object.fromEntries(OUTCOMES.map((o) => [o.key, 0])), total: 0 });
  let outOfRange = 0;
  for (const r of runs) {
    if (r.createdAt == null) continue;
    const hb = floorHour(r.createdAt);
    const i = hours.findIndex((h) => h.t === hb);
    if (i < 0) { outOfRange++; continue; }
    hours[i].counts[r.outcome.key]++;
    hours[i].total++;
  }

  // Chart: agent working time per run (turn start -> approval card), coloured by the human's decision.
  const tta = runs
    .flatMap((r) => r.approvals.filter((a) => a.cardMs != null).slice(0, 1))
    .sort((a, b) => (a.requestedAt ?? 0) - (b.requestedAt ?? 0))
    .map((a) => ({ sessionId: a.sessionId, decision: a.decision, waitMs: a.cardMs, requestedAt: a.requestedAt, result: a.result }));

  return { kpis, hours, outOfRange, tta };
}
