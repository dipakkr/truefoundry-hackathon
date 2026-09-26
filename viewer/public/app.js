// Migration Rehearsal trace viewer (read-only). Renders TrueForge sessions as Langfuse-style traces.
import { mapEvents } from "./mapEvents.mjs";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const params = new URLSearchParams(location.search);
const FIXTURE = params.has("fixture");
const POLL_MS = 1500;

let cfg = { trueforgeUi: "http://localhost:8790" };
let fixtureData = null;
let timer = null;
let listTimer = null;
const rowCache = new Map();
const state = { sessionId: null, session: null, mapped: null, selected: null, follow: true, view: "tree", dtab: "output", live: false, lastCount: -1 };

/* ---------------- formatting ---------------- */
const fdur = (msv) => msv == null ? "…" : msv < 1000 ? Math.round(msv) + "ms" : msv < 60000 ? (msv / 1000).toFixed(1) + "s" : Math.floor(msv / 60000) + "m" + String(Math.round((msv % 60000) / 1000)).padStart(2, "0") + "s";
const ftok = (n) => n == null ? "–" : n >= 10000 ? (n / 1000).toFixed(1) + "k" : n.toLocaleString();
const fusd = (n) => n == null ? "–" : "$" + (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
const ftime = (t) => t == null ? "–" : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fdate = (iso) => { const d = new Date(iso); return isNaN(d) ? "–" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
function ago(iso) { const s = (Date.now() - Date.parse(iso)) / 1000; if (!isFinite(s)) return ""; if (s < 60) return Math.max(0, Math.round(s)) + "s ago"; if (s < 3600) return Math.round(s / 60) + "m ago"; if (s < 86400) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago"; }
const short = (id) => id && id.length > 14 ? id.slice(0, 6) + "…" + id.slice(-6) : id;
const chatUrl = (sid) => `${cfg.trueforgeUi}/sessions/${encodeURIComponent(sid)}`;

function jsonHtml(v) {
  let s;
  try { s = JSON.stringify(v, null, 2); } catch { s = String(v); }
  if (s === undefined) s = "undefined";
  return esc(s)
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)/g, '<span class="j-k">$1</span>$2')
    .replace(/(:\s*)(&quot;.*?&quot;)(,?)$/gm, '$1<span class="j-s">$2</span>$3')
    .replace(/(:\s*)(-?\d+(\.\d+)?)(,?)$/gm, '$1<span class="j-n">$2</span>$4');
}
function codeHtml(src) {
  return esc(src).split("\n").map((l) => { const i = l.indexOf("--"), j = l.indexOf("#"); const k = i >= 0 ? i : (j >= 0 && !l.slice(0, j).includes("&quot;") && !l.slice(0, j).includes("'") ? j : -1); return k >= 0 ? l.slice(0, k) + '<span class="c-c">' + l.slice(k) + "</span>" : l; }).join("\n");
}
function stdoutHtml(text) {
  return String(text).split("\n").map((l) => {
    const e = esc(l);
    if (/\bERROR\b|FAIL|error:|does not exist|duplicated/.test(l)) return `<span class="t-e">${e}</span>`;
    if (/\bok\b|PASS/.test(l)) return `<span class="t-o">${e}</span>`;
    return e;
  }).join("\n");
}

/* ---------------- data access (GET only) ---------------- */
async function tf(path) {
  const r = await fetch("/tf" + path, { headers: { accept: "application/json" } });
  if (!r.ok) { let d = ""; try { d = (await r.json()).error ?? ""; } catch {} throw new Error(`${r.status} ${d || r.statusText}`); }
  return r.json();
}
async function loadFixture() {
  if (!fixtureData) fixtureData = await (await fetch("/fixtures/sample-session.json")).json();
  return fixtureData;
}
async function fetchAllEvents(sid) {
  if (FIXTURE) return (await loadFixture()).events;
  const out = [];
  let token = null;
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ limit: "100" });
    if (token) q.set("page_token", token);
    const r = await tf(`/api/v1/sessions/${encodeURIComponent(sid)}/events?${q}`);
    out.push(...(r.data || []));
    token = r.pagination?.next_page_token;
    if (!token || !(r.data || []).length) break;
  }
  return out;
}
async function fetchSession(sid) {
  if (FIXTURE) return (await loadFixture()).session;
  return (await tf(`/api/v1/sessions/${encodeURIComponent(sid)}`)).data;
}
async function fetchSessions() {
  if (FIXTURE) return [(await loadFixture()).session];
  return (await tf(`/api/v1/sessions?limit=25&order=desc`)).data || [];
}
async function fetchLatestTurn(sid) {
  if (FIXTURE) { const t = (await loadFixture()).turns; return t.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]; }
  const r = await tf(`/api/v1/sessions/${encodeURIComponent(sid)}/turns?limit=25`);
  return (r.data || []).slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] || null;
}

function setSource(kind, text) { $("srcDot").className = "dot " + kind; $("srcText").textContent = text; }

/* ---------------- session list ---------------- */
function turnStatus(turn) {
  const s = turn?.state?.status;
  if (!s) return ["–", "idle"];
  if (s === "running") return ["running", "run"];
  if (s === "paused") return ["waiting for approval", "warn"];
  if (s === "done") return (turn.state.required_actions || []).some((a) => a.type === "tool.approval_required") ? ["waiting for approval", "warn"] : ["done", "ok"];
  if (s === "error") return ["error", "bad"];
  if (s === "cancelled") return ["cancelled", "bad"];
  return [s, "idle"];
}

async function renderList() {
  stopPolling();
  state.sessionId = null;
  document.title = "Migration Rehearsal Traces";
  const app = $("app");
  app.innerHTML = `<div class="listhead"><h1>Sessions</h1><span class="mut" id="listNote"></span><span class="sp"></span><button class="btn" id="refreshBtn" type="button">Refresh</button></div>
    <div class="tbl"><table class="sessions"><thead><tr><th>session</th><th>agent</th><th>started</th><th class="r">duration</th><th>status</th><th class="r">turns</th><th class="r">tool calls</th><th class="r">cost</th></tr></thead><tbody id="rows"><tr><td colspan="8" class="mut">Loading…</td></tr></tbody></table></div>
    <div id="listMsg"></div>`;
  $("refreshBtn").addEventListener("click", () => loadList());
  $("rows").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = "#/s/" + tr.dataset.id; });
  await loadList();
  listTimer = setInterval(() => { if (!document.hidden) loadList(true); }, 5000);
}

async function loadList(quiet) {
  let sessions;
  try {
    sessions = await fetchSessions();
    setSource("on", FIXTURE ? "fixture: sample-session.json" : `live · ${cfg.trueforgeApi || "TrueForge"}`);
  } catch (e) {
    setSource("bad", "TrueForge unreachable");
    $("rows").innerHTML = `<tr><td colspan="8" class="bad">Could not load sessions: ${esc(e.message)}</td></tr>`;
    $("listMsg").innerHTML = `<div class="banner"><b>TrueForge is not reachable through the viewer proxy.</b><span class="mut">Start it with <span class="mono">npx @truefoundry/trueforge@latest</span> (port 8790) or set <span class="mono">TRUEFORGE_BASE_URL</span>. To see the viewer with sample data, open <a href="?fixture=1">?fixture=1</a>.</span></div>`;
    return;
  }
  sessions.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  $("listNote").textContent = sessions.length ? `${sessions.length} latest` : "";
  if (!sessions.length) {
    $("rows").innerHTML = `<tr><td colspan="8" class="mut">No sessions yet.</td></tr>`;
    $("listMsg").innerHTML = `<div class="banner"><span>Run the <span class="mono">migration-rehearsal</span> agent in the TrueForge chat and its session shows up here. Sample data: <a href="?fixture=1">?fixture=1</a>.</span></div>`;
    return;
  }
  $("listMsg").innerHTML = "";
  const prev = new Map([...document.querySelectorAll("#rows tr[data-id]")].map((tr) => [tr.dataset.id, tr]));
  $("rows").innerHTML = sessions.map((s) => {
    const old = prev.get(s.id);
    const keep = (k) => old?.querySelector(`[data-k="${k}"]`)?.innerHTML ?? '<span class="mut">…</span>';
    return `<tr data-id="${esc(s.id)}" tabindex="0">
      <td class="m" title="${esc(s.id)}">${esc(short(s.id))}${s.title ? `<div class="mut" style="font-family:var(--sans);font-size:11.5px;max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)}</div>` : ""}</td>
      <td>${esc(s.agent?.name ?? (s.agent?.type === "inline" ? "inline agent" : s.agent?.id ?? "–"))}</td>
      <td title="${esc(s.created_at)}">${esc(fdate(s.created_at))} <span class="mut">${esc(ago(s.created_at))}</span></td>
      <td class="r">${esc(fdur(s.metrics?.total_duration_ms))}</td>
      <td data-k="st">${keep("st")}</td>
      <td class="r">${esc(s.metrics?.total_turns ?? "–")}</td>
      <td class="r" data-k="tc">${keep("tc")}</td>
      <td class="r">${esc(fusd(s.metrics?.total_cost_in_usd))}</td></tr>`;
  }).join("");
  document.querySelectorAll("#rows tr[data-id]").forEach((tr) => tr.addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = "#/s/" + tr.dataset.id; }));
  // lazily fill status + tool call counts (Session has neither); cached per updated_at
  const queue = sessions.slice();
  const worker = async () => {
    for (let s; (s = queue.shift());) {
      const row = document.querySelector(`#rows tr[data-id="${CSS.escape(s.id)}"]`);
      if (!row) continue;
      const c = rowCache.get(s.id);
      if (c && c.updated_at === s.updated_at && c.cls !== "run") { row.querySelector('[data-k="st"]').innerHTML = c.st; row.querySelector('[data-k="tc"]').textContent = c.tc; continue; }
      try {
        const [turn, evs] = await Promise.all([fetchLatestTurn(s.id), fetchAllEvents(s.id)]);
        const m = mapEvents(evs);
        const [txt, cls] = turnStatus(turn);
        const st = turn?.state?.status === "running" ? [txt, cls] : m.summary.pendingApprovals.length ? ["waiting for approval", "warn"] : m.summary.statusClass !== "idle" ? [m.summary.status, m.summary.statusClass] : [txt, cls];
        const html = `<span class="st ${st[1]}">${esc(st[0])}</span>`;
        rowCache.set(s.id, { updated_at: s.updated_at, st: html, tc: String(m.summary.toolCalls), cls: st[1] });
        row.querySelector('[data-k="st"]').innerHTML = html;
        row.querySelector('[data-k="tc"]').textContent = m.summary.toolCalls;
      } catch { row.querySelector('[data-k="st"]').innerHTML = '<span class="mut">?</span>'; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

/* ---------------- trace view ---------------- */
function stopPolling() { clearTimeout(timer); timer = null; clearInterval(listTimer); listTimer = null; }

async function renderTrace(sid) {
  stopPolling();
  const fresh = state.sessionId !== sid;
  if (fresh) Object.assign(state, { sessionId: sid, session: null, mapped: null, selected: null, follow: true, dtab: "output", lastCount: -1 });
  const app = $("app");
  app.innerHTML = `<div class="crumb"><a href="${FIXTURE ? "?fixture=1#/" : "#/"}">Sessions</a><span>/</span><b id="sid">${esc(sid)}</b></div>
    <div class="thead"><h1 id="title">Loading…</h1><span class="st idle" id="status">–</span><div class="chips" id="hchips"></div><span style="flex:1"></span><a class="btn" id="chatBtn" target="_blank" rel="noopener" href="${esc(chatUrl(sid))}">Open chat in TrueForge</a></div>
    <div class="prod" id="prod"></div>
    <div id="alert"></div>
    <div class="rehearsals" id="rehearsals"></div>
    <div class="split">
      <section class="treepane" aria-label="Trace">
        <div class="tbar">
          <div class="seg" role="group" aria-label="View"><button type="button" id="vTree" aria-pressed="${state.view === "tree"}">Tree</button><button type="button" id="vTime" aria-pressed="${state.view === "time"}">Timeline</button></div>
          <span class="sp"></span>
          <span class="nr" id="liveNote"></span>
          <button class="follow" type="button" id="followBtn" aria-pressed="${state.follow}">● follow latest</button>
        </div>
        <ul class="tree" id="tree"><li class="empty">Loading events…</li></ul>
      </section>
      <section class="detail" aria-label="Observation detail"><div id="detail"></div></section>
    </div>`;
  $("tree").addEventListener("click", (e) => { const li = e.target.closest(".node"); if (li) pick(li.dataset.id); });
  $("tree").addEventListener("keydown", (e) => {
    const li = e.target.closest(".node"); if (!li) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(li.dataset.id); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const sib = e.key === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling; if (sib?.dataset.id) { pick(sib.dataset.id); sib.focus(); } }
  });
  $("followBtn").addEventListener("click", () => { state.follow = !state.follow; $("followBtn").setAttribute("aria-pressed", String(state.follow)); if (state.follow) selectLatest(); renderTree(); renderDetail(); });
  $("vTree").addEventListener("click", () => { state.view = "tree"; $("vTree").setAttribute("aria-pressed", "true"); $("vTime").setAttribute("aria-pressed", "false"); renderTree(); });
  $("vTime").addEventListener("click", () => { state.view = "time"; $("vTime").setAttribute("aria-pressed", "true"); $("vTree").setAttribute("aria-pressed", "false"); renderTree(); });
  await refreshTrace(true);
}

function selectLatest() {
  const o = state.mapped?.observations || [];
  if (!o.length) return;
  const pending = o.find((x) => x.type === "APPROVAL" && !x.decision);
  const latest = o.reduce((a, b) => ((b.start ?? 0) > (a.start ?? 0) || ((b.start ?? 0) === (a.start ?? 0) && b.seq > a.seq) ? b : a));
  state.selected = (pending || latest).id;
}

async function refreshTrace(first) {
  const sid = state.sessionId;
  if (!sid) return;
  try {
    const [session, events] = await Promise.all([fetchSession(sid), fetchAllEvents(sid)]);
    if (sid !== state.sessionId) return;
    state.session = session;
    const changed = events.length !== state.lastCount;
    state.lastCount = events.length;
    if (changed || first) {
      state.mapped = mapEvents(events);
      if (first && !state.selected) {
        const reportNode = [...state.mapped.observations].reverse().find((x) => x.type === "APPROVAL") || null;
        state.selected = state.mapped.summary.running || state.mapped.summary.pendingApprovals.length ? null : reportNode?.id ?? null;
      }
      if (state.follow && (state.mapped.summary.running || state.mapped.summary.pendingApprovals.length || !state.selected)) selectLatest();
      renderHeader(); renderTree(); renderDetail();
    }
    setSource(state.mapped.summary.running ? "run" : "on", FIXTURE ? "fixture: sample-session.json" : state.mapped.summary.running ? "live · following turn" : "live · TrueForge");
  } catch (e) {
    setSource("bad", "TrueForge unreachable");
    if (first) $("tree").innerHTML = `<li class="empty bad">Could not load session: ${esc(e.message)}</li>`;
  }
  const s = state.mapped?.summary;
  // Live follow: poll the persisted event list while a turn runs or waits on a human.
  if (!FIXTURE && s && (s.running || s.pendingApprovals.length)) {
    $("liveNote").textContent = s.running ? `polling every ${POLL_MS / 1000}s` : "waiting on TrueForge approval";
    timer = setTimeout(() => refreshTrace(false), document.hidden ? POLL_MS * 4 : s.running ? POLL_MS : POLL_MS * 2);
  } else if ($("liveNote")) $("liveNote").textContent = "";
}

function renderHeader() {
  const { summary: s } = state.mapped;
  const ses = state.session || {};
  document.title = `${ses.title || "Session"} · Migration Rehearsal Traces`;
  $("title").textContent = ses.title || `session ${short(state.sessionId)}`;
  const st = $("status"); st.textContent = s.status; st.className = "st " + s.statusClass;
  const cost = ses.metrics?.total_cost_in_usd ?? s.costUsd;
  $("hchips").innerHTML = [
    ["agent", ses.agent?.name ?? "–"],
    ["turns", s.turns],
    ["latency", fdur(s.durationMs)],
    ["tokens", ftok(s.tokens)],
    ["cost", fusd(cost)],
    ["tool calls", s.toolCalls],
  ].map(([k, v]) => `<span class="chip num"><i>${esc(k)}</i> ${esc(v)}</span>`).join("");

  const p = s.prodState;
  if (p) {
    const cols = Array.isArray(p.columns_users) ? p.columns_users.filter((c) => c === "phone" || c === "mobile").join(", ") || "–" : "–";
    $("prod").innerHTML = `<span class="lbl">prod (verify_prod_state · ${esc(ftime(p.at))})</span>` + [
      ["prod.users", p.row_counts?.users?.toLocaleString?.() ?? "–"],
      ["prod.orders", p.row_counts?.orders?.toLocaleString?.() ?? "–"],
      ["users_email_lower_uniq", p.has_index_users_email_lower_uniq ? "present" : "absent"],
      ["users contact cols", cols],
      ["version", p.last_applied_version ?? "–"],
    ].map(([k, v]) => `<button type="button" class="chip" data-go="${esc(p.obsId)}"><i>${esc(k)}</i> <b>${esc(v)}</b></button>`).join("");
  } else {
    $("prod").innerHTML = `<span class="lbl">prod state: no <span class="mono">pgwarden.verify_prod_state</span> result in this session yet</span>`;
  }
  $("prod").querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => pick(b.dataset.go)));

  if (s.pendingApprovals.length) {
    const a = s.pendingApprovals[0];
    $("alert").innerHTML = `<div class="alertbar"><b>Approval required</b><span><span class="mono">${esc(a.tool || "tool call")}</span> is waiting for a human decision.</span><button class="btn" type="button" id="showAppr">Show request</button><a class="btn gate" target="_blank" rel="noopener" href="${esc(chatUrl(state.sessionId))}">Decide in TrueForge ↗</a></div>`;
    $("showAppr").addEventListener("click", () => pick(a.id));
  } else $("alert").innerHTML = "";

  const reps = s.reports;
  $("rehearsals").innerHTML = reps.length ? `<span class="lbl mut" style="font-size:11.5px">rehearsals</span>` + reps.map((r) => {
    const node = state.mapped.observations.find((o) => o.report === r.report);
    const ok = r.report.verdict === "pass";
    return `<button type="button" class="chip" data-go="${esc(node?.id ?? "")}"><i>attempt ${esc(r.report.attempt ?? "?")}</i> <span class="${ok ? "ok" : "bad"}">${esc(r.report.verdict)}</span>${r.report.effects?.row_deltas ? ` <i>·</i> ${esc(Object.entries(r.report.effects.row_deltas).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", "))}` : ""}</button>`;
  }).join("") : "";
  $("rehearsals").querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => { if (b.dataset.go) { state.dtab = "output"; pick(b.dataset.go); } }));
}

function pick(id) {
  if (!id) return;
  state.selected = id;
  state.follow = false;
  const fb = $("followBtn"); if (fb) fb.setAttribute("aria-pressed", "false");
  renderTree(); renderDetail();
  const li = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  if (li) li.scrollIntoView({ block: "nearest" });
}

function renderTree() {
  const list = state.mapped?.observations || [];
  const tree = $("tree");
  if (!tree) return;
  if (!list.length) { tree.innerHTML = '<li class="empty">No events in this session yet.</li>'; return; }
  const now = Date.now();
  const t0 = Math.min(...list.map((o) => o.start ?? Infinity));
  const tEnd = Math.max(...list.map((o) => o.end ?? (o.status === "run" || o.status === "wait" ? Math.min(now, (state.mapped.summary.lastTs ?? now) + 1) : o.start ?? 0)));
  const span = Math.max(tEnd - t0, 1);
  tree.innerHTML = list.map((n) => {
    const d = n.end != null && n.start != null ? n.end - n.start : null;
    const lv = n.status === "run" ? '<span class="lv run" title="running"></span>' : n.status === "bad" ? '<span class="lv bad" title="error"></span>' : n.status === "wait" ? '<span class="lv wait" title="waiting for a human"></span>' : "";
    const code = n.errorCode ? `<span class="code-tag">${esc(n.errorCode)}</span>` : n.meta?.denied ? '<span class="code-tag">denied</span>' : "";
    const tok = n.type === "GENERATION" && n.usage ? n.usage.input + n.usage.output : n.type === "TRACE" ? n.tokens : 0;
    let right;
    if (state.view === "time") {
      const s = n.start ?? t0, e = n.end ?? tEnd;
      right = `<span class="bar" aria-hidden="true"><span class="${n.type}" style="left:${(((s - t0) / span) * 100).toFixed(2)}%;width:${Math.max(((e - s) / span) * 100, 0.6).toFixed(2)}%"></span></span>`;
    } else {
      const lat = n.status === "wait" && n.end == null ? "waiting" : n.type === "EVENT" ? "+" + fdur((n.start ?? t0) - t0) : fdur(d);
      right = `<span class="nr">${esc(lat)}${tok ? " · " + esc(ftok(tok)) + " tok" : ""}</span>`;
    }
    return `<li class="node${state.selected === n.id ? " sel" : ""}${n.dim ? " dim" : ""}" data-id="${esc(n.id)}" tabindex="0"><span class="nl"><span class="ind" style="width:${8 + n.level * 16}px"></span><span class="ty ${n.type}">${n.type}</span><span class="nm" title="${esc(n.name)}">${esc(n.name)}</span>${code}${lv}</span>${right}</li>`;
  }).join("");
}

/* ---------------- detail pane ---------------- */
function reportHtml(r) {
  if (!r) return "";
  const ok = r.verdict === "pass";
  const rows = [];
  for (const s of r.steps || []) rows.push(["step " + (s.index ?? ""), s.sql_preview ?? "", s.ms != null ? s.ms + "ms" : "–", s.ok, s.error]);
  for (const q of r.query_replay || []) rows.push(["query", q.file ?? "", "–", q.ok, q.error]);
  for (const i of r.invariants || []) rows.push(["invariant", i.name + (i.detail != null ? ` (${i.detail})` : ""), "–", i.ok, null]);
  for (const c of r.constraint_violations || []) rows.push(["violation", `${c.constraint}: ${c.violating_groups} groups`, "–", false, (c.examples_masked || []).join("\n")]);
  const eff = r.effects;
  return `<div class="sec"><span class="l">RehearsalReport · attempt ${esc(r.attempt ?? "?")} · verdict <span class="${ok ? "ok" : "bad"}">${esc(r.verdict)}</span>${r.duration_ms != null ? " · " + esc(fdur(r.duration_ms)) : ""}${r.source_rows ? " · source rows " + esc(Object.entries(r.source_rows).map(([k, v]) => `${k} ${Number(v).toLocaleString()}`).join(", ")) : ""}</span>
    <div class="tbl"><table><thead><tr><th>check</th><th>target</th><th class="r">time</th><th>result</th></tr></thead><tbody>${rows.map(([a, b, c, okk, err]) => `<tr><td>${esc(a)}</td><td class="m">${esc(b)}${err ? `<div class="bad" style="white-space:pre-wrap">${esc(err)}</div>` : ""}</td><td class="r">${esc(c)}</td><td class="${okk ? "ok" : "bad"}">${okk ? "pass" : "fail"}</td></tr>`).join("")}</tbody></table></div></div>
    ${eff ? `<div class="sec"><span class="l">effects (row_deltas + schema_changes)</span><div class="tbl"><table><tbody>${Object.entries(eff.row_deltas || {}).map(([k, v]) => `<tr><td class="m">${esc(k)}</td><td class="r">${v > 0 ? "+" : ""}${esc(v)}</td></tr>`).join("")}${(eff.schema_changes || []).map((c) => `<tr><td class="m" colspan="2">${esc(c)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
    <details><summary>raw RehearsalReport JSON</summary><pre class="box">${jsonHtml(r)}</pre></details>`;
}

function argsHtml(v) {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof v.sql === "string") {
    const { sql, report, ...rest } = v;
    return `<div class="sec"><span class="l">sql</span><pre class="box code">${codeHtml(sql)}</pre></div>` +
      (Object.keys(rest).length ? `<div class="sec"><span class="l">arguments</span><pre class="box">${jsonHtml(rest)}</pre></div>` : "") +
      (report ? `<details><summary>report argument</summary><pre class="box">${jsonHtml(report)}</pre></details>` : "");
  }
  if (v && typeof v === "object" && typeof v.body === "string" && v.body.length > 120) {
    const { body, ...rest } = v;
    return `<div class="sec"><span class="l">arguments</span><pre class="box">${jsonHtml(rest)}</pre></div><div class="sec"><span class="l">body</span><pre class="box">${esc(body)}</pre></div>`;
  }
  return `<div class="sec"><span class="l">arguments</span><pre class="box">${jsonHtml(v)}</pre></div>`;
}

function downloadLink(n, path) {
  if (!path || FIXTURE) return "";
  const q = new URLSearchParams({ path });
  return ` <a class="btn" href="/tf/api/v1/sessions/${encodeURIComponent(state.sessionId)}/turns/${encodeURIComponent(n.turnId)}/download-sandbox-file?${q}">Download from sandbox</a>`;
}

function outputHtml(n) {
  const o = n.output;
  let h = "";
  if (n.report) h += reportHtml(n.report);
  if (n.meta?.offloaded_to) h += `<div class="note">TrueForge offloaded this large response to the sandbox (<span class="mono">${esc(n.meta.offloaded_to)}</span>); the model only saw a preview.${downloadLink(n, n.meta.offloaded_to.startsWith("/") ? n.meta.offloaded_to : null)}</div>`;
  if (!o) return h + `<div class="sec"><span class="l">Output</span><div class="note">${n.status === "wait" ? "Waiting for a human decision in TrueForge." : n.status === "run" ? "Running…" : "–"}</div></div>`;
  switch (o.kind) {
    case "generation": {
      if (o.text) h += `<div class="sec"><span class="l">assistant</span><pre class="box">${esc(o.text)}</pre></div>`;
      if (o.reasoning) h += `<details><summary>reasoning</summary><pre class="box">${esc(o.reasoning)}</pre></details>`;
      if (o.tool_calls?.length) h += `<div class="sec"><span class="l">tool calls</span><div class="calls">${o.tool_calls.map((c) => `<div class="sec"><div class="callrow"><button class="pill" type="button" data-go="call:${esc(c.id)}" style="cursor:pointer">${esc(c.name)}</button><span class="mut mono" style="font-size:11px">${esc(c.id)}</span></div></div>`).join("")}</div></div>`;
      if (!o.text && !o.tool_calls?.length) h += '<div class="note">Empty message.</div>';
      return h;
    }
    case "exec": {
      h += `<div class="sec"><span class="l">exit code <span class="${o.exitCode === 0 ? "ok" : "bad"}">${esc(o.exitCode)}</span> · stdout/stderr</span><pre class="box">${stdoutHtml(o.stdout)}</pre></div>`;
      return h + codeModeNote(n);
    }
    case "error":
      return h + `<div class="sec"><span class="l">error${o.code ? ` · <span class="bad mono">${esc(o.code)}</span>` : ""}</span><pre class="box err">${typeof o.v === "string" ? esc(o.v) : jsonHtml(o.v)}</pre></div>` + (n.type === "SPAN" ? codeModeNote(n) : "");
    case "json": return h + `<div class="sec"><span class="l">Output</span><pre class="box">${jsonHtml(o.v)}</pre></div>`;
    case "text": return h + `<div class="sec"><span class="l">Output</span><pre class="box${/^\s*(--|create|alter|select|with)\b/i.test(o.v) ? " code" : ""}">${/^\s*(--|create|alter)\b/i.test(o.v) ? codeHtml(o.v) : esc(o.v)}</pre></div>`;
    default: return h + `<pre class="box">${jsonHtml(o)}</pre>`;
  }
}
function codeModeNote(n) {
  if (!n.codeModeCalls?.length) return "";
  return `<div class="sec"><span class="l">MCP calls referenced in this script (Code Mode)</span><div class="callrow">${n.codeModeCalls.map((c) => `<span class="pill">${esc(c.name)}${c.count > 1 ? " ×" + c.count : ""}</span>`).join("")}</div><div class="note">Code Mode calls are bridged through the harness but TrueForge does not emit session events for them, so they are read from the script text and not shown as separate observations.</div></div>`;
}

function inputHtml(n) {
  const i = n.input;
  if (!i) return '<div class="note">–</div>';
  if (i.kind === "exec") {
    const v = i.v || {};
    return (v.intent ? `<div class="sec"><span class="l">intent</span><pre class="box">${esc(v.intent)}</pre></div>` : "") +
      `<div class="sec"><span class="l">command${v.cwd ? " · cwd " + esc(v.cwd) : ""}</span><pre class="box code">${codeHtml(v.command ?? "")}</pre></div>` + codeModeNote(n);
  }
  if (i.kind === "context") {
    if (!i.items.length) return `<div class="note">${n.parentId && state.mapped.observations.find((o) => o.id === n.parentId)?.input?.kind === "text" ? "User message (see the turn's Input) and prior context." : "Prior context."} TrueForge events do not include the full prompt sent to the model.</div>`;
    return `<div class="sec"><span class="l">tool results since the previous generation</span>${i.items.map((c) => `<div class="sec"><div class="callrow"><span class="pill">${esc(c.name)}</span><span class="${c.ok ? "ok" : "bad"}">${c.ok ? "ok" : "error"}</span></div><pre class="box">${esc(c.preview)}${c.preview.length >= 280 ? "…" : ""}</pre></div>`).join("")}</div>`;
  }
  if (i.kind === "text") return `<div class="sec"><span class="l">Input</span><pre class="box">${esc(i.v)}</pre></div>`;
  if (i.kind === "json") return argsHtml(i.v);
  return `<pre class="box">${jsonHtml(i)}</pre>`;
}

function approvalHtml(n) {
  const a = n.input?.v || {};
  const waiting = !n.decision;
  const head = waiting
    ? `<div class="q"><span class="st warn">waiting for a human</span><span>${esc(n.toolName || "tool call")} needs approval</span><a class="btn gate" target="_blank" rel="noopener" href="${esc(chatUrl(state.sessionId))}">Decide in TrueForge ↗</a></div><div class="note">The viewer is read-only. Allow or deny in the TrueForge chat; this page updates when the decision lands.</div>`
    : `<div class="q"><span class="st ${n.decision === "allow" ? "ok" : "bad"}">${esc(n.decision === "allow" ? "allowed" : n.decision === "deny" ? "denied" : n.decision)}</span><span class="mut">decided in TrueForge at ${esc(ftime(n.end))} · after ${esc(fdur(n.end - n.start))}</span></div>${n.decisionReason ? `<div class="note">reason: ${esc(n.decisionReason)}</div>` : ""}`;
  const exec = state.mapped.observations.find((o) => o.id === `call:${n.meta.tool_call_id}`);
  const result = exec && exec.end != null ? `<div class="sec"><span class="l">result after decision</span><div class="callrow"><button class="pill" type="button" data-go="${esc(exec.id)}" style="cursor:pointer">${esc(exec.name)}</button><span class="${exec.status === "ok" ? "ok" : "bad"}">${esc(exec.errorCode || (exec.meta.denied ? "denied" : exec.output?.v?.status ?? exec.status))}</span></div></div>` : "";
  return `<div class="gatebox${waiting ? "" : " done"}">${head}
    ${a.declared_effects ? `<div class="sec"><span class="l">declared_effects (server-enforced)</span><pre class="box">${jsonHtml(a.declared_effects)}</pre></div>` : ""}
    ${a.evidence_summary ? `<div class="sec"><span class="l">evidence_summary</span><pre class="box">${esc(a.evidence_summary)}</pre></div>` : ""}
    ${typeof a.sql === "string" ? `<div class="sec"><span class="l">sql</span><pre class="box code"${/\bdrop\s+table\b|\btruncate\b/i.test(a.sql.replace(/--.*$/gm, "")) ? ' style="color:var(--bad)"' : ""}>${codeHtml(a.sql)}</pre></div>` : ""}
    ${a.rehearsal_id ? `<div class="sec"><span class="l">rehearsal_id</span><pre class="box">${esc(a.rehearsal_id)}</pre></div>` : ""}
    ${!a.sql && !a.declared_effects ? `<div class="sec"><span class="l">arguments</span><pre class="box">${jsonHtml(a)}</pre></div>` : ""}
    ${result}</div>`;
}

function renderDetail() {
  const box = $("detail");
  if (!box) return;
  const list = state.mapped?.observations || [];
  const n = list.find((o) => o.id === state.selected);
  if (!n) { box.innerHTML = `<div class="empty">${list.length ? "Select an observation." : ""}</div>`; return; }
  const t0 = state.mapped.summary.firstTs ?? n.start;
  const st = n.status === "run" ? '<span class="st run">running</span>' : n.status === "bad" ? `<span class="st bad">${esc(n.errorCode || (n.meta?.denied ? "denied" : n.output?.kind === "exec" ? "exit " + n.output.exitCode : "error"))}</span>` : n.status === "wait" ? '<span class="st warn">waiting for a human</span>' : '<span class="st ok">ok</span>';
  const chips = [["start", "+" + fdur((n.start ?? t0) - t0)], ["latency", n.end == null ? "…" : fdur(n.end - n.start)]];
  if (n.usage) chips.push(["tokens", `${ftok(n.usage.input)} in · ${ftok(n.usage.output)} out${n.usage.cache_read ? ` · ${ftok(n.usage.cache_read)} cached` : ""}`]);
  if (n.type === "TRACE" && n.metrics) { chips.push(["tokens", ftok(n.tokens)]); if (n.metrics.total_cost_in_usd != null) chips.push(["cost", fusd(n.metrics.total_cost_in_usd)]); }
  if (n.meta?.server) chips.push(["server", n.meta.server]);
  if (n.meta?.via) chips.push(["via", n.meta.via]);
  const tabs = n.type === "APPROVAL" ? ["decision", "input", "metadata"] : ["output", "input", "metadata"];
  if (!tabs.includes(state.dtab)) state.dtab = tabs[0];
  let body;
  if (state.dtab === "input") body = inputHtml(n);
  else if (state.dtab === "metadata") {
    const meta = { observation: n.id, type: n.type, turn_id: n.turnId, start: n.start ? new Date(n.start).toISOString() : null, end: n.end ? new Date(n.end).toISOString() : null, ...n.meta };
    body = `<dl class="kv">${Object.entries(meta).filter(([, v]) => v != null && v !== "").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`).join("")}</dl>` +
      (n.usage?.breakdown ? `<div class="sec"><span class="l">input_tokens_breakdown</span><pre class="box">${jsonHtml(n.usage.breakdown)}</pre></div>` : "") +
      (n.metrics ? `<div class="sec"><span class="l">TurnMetrics</span><pre class="box">${jsonHtml(n.metrics)}</pre></div>` : "");
  } else if (state.dtab === "decision") body = approvalHtml(n);
  else body = n.type === "TRACE" ? traceOutput(n) : outputHtml(n);
  box.innerHTML = `<div class="dh"><div class="t"><span class="ty ${n.type}">${n.type}</span><b>${esc(n.name)}</b>${st}</div><div class="chips">${chips.map(([k, v]) => `<span class="chip num"><i>${esc(k)}</i> ${esc(v)}</span>`).join("")}</div></div>
    <div class="dtabs" role="tablist">${tabs.map((t) => `<button class="dtab" role="tab" type="button" data-t="${t}" aria-selected="${t === state.dtab}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
    <div class="dbody">${body}</div>`;
  box.querySelectorAll(".dtab").forEach((b) => b.addEventListener("click", () => { state.dtab = b.dataset.t; renderDetail(); }));
  box.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => pick(b.dataset.go)));
}

function traceOutput(n) {
  let h = "";
  if (n.meta.required_actions) h += `<div class="gatebox"><div class="q"><span class="st warn">turn ended with required actions</span><span class="mono">${esc(n.meta.required_actions)}</span></div><div class="note">The harness paused for a human. The decision arrives as the next turn's input (<span class="mono">user.tool_approval</span>).</div></div>`;
  h += n.output ? `<div class="sec"><span class="l">final assistant message</span><pre class="box">${esc(n.output.v)}</pre></div>` : `<div class="note">${n.end == null ? "Turn in progress…" : "No final message."}</div>`;
  return h;
}

/* ---------------- routing ---------------- */
async function route() {
  const m = /^#\/s\/(.+)$/.exec(location.hash);
  if (m) return renderTrace(decodeURIComponent(m[1]));
  if (FIXTURE && !location.hash) { const f = await loadFixture(); location.replace("#/s/" + f.session.id); return; }
  return renderList();
}

(async function init() {
  try { cfg = { ...cfg, ...(await (await fetch("/config.json")).json()) }; } catch {}
  $("tfLink").href = cfg.trueforgeUi;
  if (FIXTURE) $("homeLink").href = "?fixture=1#/";
  window.addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.sessionId && timer) { clearTimeout(timer); refreshTrace(false); } });
  route();
})();
