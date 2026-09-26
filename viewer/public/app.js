// Migration Rehearsal trace viewer (read-only). Renders TrueForge sessions as Langfuse-style traces.
import { mapEvents } from "./mapEvents.mjs";
import { sessionRow, aggregate, repoPrFromText, OUTCOMES, DEFAULT_REPO, isRunAgent } from "./dashboard.mjs";
import { reviewMigration } from "./review.mjs";

// Protected tables per pgwarden MCP server, from the onboarded projects (empty when unavailable, e.g. fixture mode).
let protectedByServer = {};
fetch("/api/projects", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
  .then((b) => { for (const p of b?.data || []) protectedByServer[p.pgwarden.mcp_name] = p.protected_tables || []; })
  .catch(() => {});

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const params = new URLSearchParams(location.search);
const FIXTURE = params.has("fixture");
const POLL_MS = 1500;
const PAGE_REFRESH_MS = 10000; // dashboard / lists
const SESSION_TTL_MS = 8000; // re-fetch a session's events only if updated_at changed, or it is live and older than this
const SESSION_PAGES = 4; // up to 100 sessions (25 per page)

let cfg = { trueforgeUi: "http://localhost:8790" };
let fixtureData = null;
let timer = null; // trace live-follow
let pageTimer = null; // list/dashboard refresh
let routeSeq = 0;
const state = { sessionId: null, session: null, mapped: null, selected: null, follow: true, view: "tree", dtab: "output", live: false, lastCount: -1 };

/* ---------------- formatting ---------------- */
const fdur = (msv) => msv == null ? "…" : msv < 1000 ? Math.round(msv) + "ms" : msv < 60000 ? (msv / 1000).toFixed(1) + "s" : msv < 3600e3 ? Math.floor(msv / 60000) + "m " + String(Math.round((msv % 60000) / 1000)).padStart(2, "0") + "s" : Math.floor(msv / 3600e3) + "h " + String(Math.round((msv % 3600e3) / 60000)).padStart(2, "0") + "m";
const fdurOr = (msv, dash = "–") => msv == null ? dash : fdur(msv);
const ftok = (n) => n == null ? "–" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 10000 ? (n / 1000).toFixed(1) + "k" : n.toLocaleString();
const fusd = (n) => n == null ? "–" : "$" + (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
const ftime = (t) => t == null ? "–" : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fdate = (iso) => { const d = new Date(iso); return isNaN(d) ? "–" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
function ago(iso) { const s = (Date.now() - (typeof iso === "number" ? iso : Date.parse(iso))) / 1000; if (!isFinite(s)) return ""; if (s < 60) return Math.max(0, Math.round(s)) + "s ago"; if (s < 3600) return Math.round(s / 60) + "m ago"; if (s < 86400) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago"; }
const short = (id) => id && id.length > 14 ? id.slice(0, 6) + "…" + id.slice(-6) : id;
const chatUrl = (sid) => `${cfg.trueforgeUi}/sessions/${encodeURIComponent(sid)}`;
const traceHref = (sid, obs) => "#/s/" + encodeURIComponent(sid) + (obs ? "?o=" + encodeURIComponent(obs) : "");

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
  const out = [];
  let token = null;
  for (let i = 0; i < SESSION_PAGES; i++) {
    const q = new URLSearchParams({ limit: "25" });
    if (token) q.set("page_token", token);
    const r = await tf(`/api/v1/sessions?${q}`);
    out.push(...(r.data || []));
    token = r.pagination?.next_page_token;
    if (!token || !(r.data || []).length) break;
  }
  return out;
}

function setSource(kind, text) { $("srcDot").className = "dot " + kind; $("srcText").textContent = text; }
const liveText = () => FIXTURE ? "fixture · sample-session.json" : "live · TrueForge";

/* ---------------- shared session cache ---------------- */
// id -> { updated_at, at, row, live }
const cache = new Map();
let rowsInflight = null;
let lastRows = null;
let lastRowsAt = 0;
let lastRowsError = null;

/** All sessions as table rows (sessionRow), newest first. Events fetched 3 sessions at a time. */
function loadRows() {
  if (rowsInflight) return rowsInflight;
  rowsInflight = (async () => {
    try {
      const sessions = await fetchSessions();
      const now = Date.now();
      const queue = sessions.filter((s) => {
        const c = cache.get(s.id);
        return !(c && c.updated_at === s.updated_at && (!c.live || now - c.at < SESSION_TTL_MS));
      });
      const worker = async () => {
        for (let s; (s = queue.shift());) {
          try {
            const m = mapEvents(await fetchAllEvents(s.id));
            const row = sessionRow(s, m);
            cache.set(s.id, { updated_at: s.updated_at, at: Date.now(), row, live: m.summary.running || m.summary.pendingApprovals.length > 0 });
          } catch (e) {
            if (!cache.has(s.id)) cache.set(s.id, { updated_at: null, at: 0, row: failedRow(s, e), live: true });
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const rows = sessions.map((s) => cache.get(s.id)?.row).filter(Boolean).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      lastRows = rows; lastRowsAt = Date.now(); lastRowsError = null;
      setSource("on", liveText());
      updateShellFromRows(rows);
      return rows;
    } catch (e) {
      lastRowsError = e;
      setSource("bad", "TrueForge unreachable");
      throw e;
    } finally { rowsInflight = null; }
  })();
  return rowsInflight;
}
function failedRow(s, e) {
  return { id: s.id, createdAt: Date.parse(s.created_at), prompt: s.title || "", agent: s.agent?.name ?? "inline", isRehearsal: isRunAgent(s.agent?.name), outcome: { key: "error", label: "load failed", cls: "err", full: String(e.message || e) }, latencyMs: s.metrics?.total_duration_ms ?? null, ttaMs: null, pending: 0, tokens: 0, toolCalls: null, sandboxRuns: null, approvals: [], ...repoPrFromText(s.title) };
}

function updateShellFromRows(rows) {
  const newest = rows.find((r) => r.isRehearsal && r.repo) || rows.find((r) => r.repo);
  $("projRepo").textContent = newest?.repo || DEFAULT_REPO;
  if (!state.sessionId) setPrLink(newest);
  setApprBadge(rows.reduce((n, r) => n + (r.pending || 0), 0));
}
function setApprBadge(pending) {
  const b = $("apprBadge");
  b.hidden = !pending; b.textContent = pending ? String(pending) : "";
}
function setPrLink(row) {
  const a = $("prLink");
  if (row?.url) { a.href = row.url; a.classList.remove("disabled"); a.title = `GitHub PR · ${row.repo}#${row.pr}`; $("prLabel").textContent = `GitHub PR #${row.pr}`; }
  else { a.href = "#"; a.classList.add("disabled"); a.title = "No PR found in the session prompt"; $("prLabel").textContent = "GitHub PR"; }
}

/* ---------------- shell ---------------- */
function setActiveNav(key) {
  document.querySelectorAll(".nav[data-nav]").forEach((a) => { if (a.dataset.nav === key) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
}
function stopPolling() { clearTimeout(timer); timer = null; clearInterval(pageTimer); pageTimer = null; }
function startPageRefresh(fn) { pageTimer = setInterval(() => { if (!document.hidden) fn(true); }, PAGE_REFRESH_MS); }

function pageHead(crumb, title, extra = "") {
  return `<div class="phead"><div><div class="crumb">${crumb}</div><h1>${esc(title)}</h1></div><span class="sp"></span>${extra}<span class="meta-note" id="updNote"></span><button class="btn" id="refreshBtn" type="button">Refresh</button></div>`;
}
function setUpdated() { const n = $("updNote"); if (n) n.textContent = lastRowsAt ? `updated ${ftime(lastRowsAt)}` : ""; }

function errorBanner(e) {
  return `<div class="banner bad"><b>TrueForge is not reachable through the viewer proxy.</b><span>${esc(e?.message || e)}</span><span class="mut">Start it with <span class="mono">npx @truefoundry/trueforge@latest</span> (port 8790) or set <span class="mono">TRUEFORGE_BASE_URL</span>. To see the viewer with sample data, open <a href="?fixture=1">?fixture=1</a>.</span></div>`;
}


/* ---------------- projects + onboarding ---------------- */
async function renderProjects() {
  const tok = routeSeq;
  setActiveNav("projects");
  document.title = "Projects · Migration Rehearsal";
  $("app").innerHTML = pageHead("Setup", "Projects", `<button class="btn gate" id="onbBtn" type="button">+ Onboard project</button>`) + `
    <div class="card" id="onbCard" hidden style="margin-bottom:16px">
      <header><h2>Onboard a project</h2><span class="s">connects an app repo and its prod Postgres; same steps as <span class="mono">npm run onboard</span></span></header>
      <form id="onbForm" class="onb">
        <label>Project name<input name="project" required pattern="[a-z][a-z0-9-]{1,30}" placeholder="ledgerly"></label>
        <label>GitHub repo<input name="repo" required pattern="[\w.-]+/[\w.-]+" placeholder="owner/app"></label>
        <label>Prod database variable<input name="dbEnv" pattern="[A-Z][A-Z0-9_]{1,60}" placeholder="LEDGERLY_DATABASE_URL"><small>Name of the .env variable holding the URL. The URL itself never leaves the server.</small></label>
        <label>Migrations path<input name="migrations" placeholder="migrations"></label>
        <label>App queries path<input name="queries" placeholder="src/queries"></label>
        <div class="onb-act"><button class="btn gate" type="submit" id="onbGo">Run onboarding</button><span class="meta-note">DB check → PII scan → pgwarden + agent in TrueForge → workflow PR → runner</span></div>
      </form>
      <pre class="box onb-out" id="onbOut" hidden></pre>
    </div>
    <div class="tbl"><table class="dtable"><thead><tr><th>Project</th><th>Repo</th><th>pgwarden</th><th>Agent</th><th>CI workflow</th><th>Runner</th><th>Masked PII</th><th class="r">Runs</th><th>Last run</th></tr></thead><tbody id="rows">${skeletonRows(9, 2)}</tbody></table></div>
    <div id="listMsg"></div>`;
  const yes = (v, ok, bad) => v == null ? `<span class="mut">?</span>` : v ? `<span class="st ok">${ok}</span>` : `<span class="st bad">${bad}</span>`;
  const load = async () => {
    let data;
    try { data = (await (await fetch("/api/projects", { cache: "no-store" })).json()).data; }
    catch (e) { if (tok === routeSeq) $("listMsg").innerHTML = errorBanner(e); return; }
    if (tok !== routeSeq) return;
    $("rows").innerHTML = data.length ? data.map((p) => `<tr>
      <td><b>${esc(p.name)}</b></td>
      <td><a href="https://github.com/${esc(p.repo)}" target="_blank" rel="noopener" class="mono">${esc(p.repo)}</a></td>
      <td>${yes(p.health.pgwarden_up, "up", "down")} <span class="mono mut" style="font-size:11px">${esc(p.pgwarden.mcp_name)} :${p.pgwarden.port}</span></td>
      <td>${yes(p.health.agent_registered, "registered", "missing")} <span class="mono mut" style="font-size:11px">${esc(p.agent)}</span></td>
      <td>${yes(p.health.workflow, "installed", "not installed")}</td>
      <td>${p.health.runners_online == null ? '<span class="mut">?</span>' : p.health.runners_online > 0 ? `<span class="st ok">${p.health.runners_online} online</span>` : '<span class="st bad">offline</span>'}</td>
      <td title="${esc(p.masked_columns.join(", "))}">${p.masked_columns.length} columns</td>
      <td class="r">${p.runs}</td>
      <td>${p.last_run ? `<a href="${traceHref(p.last_run.id)}">${esc(ftime(Date.parse(p.last_run.at)))}</a>` : '<span class="mut">–</span>'}</td></tr>`).join("")
      : `<tr><td colspan="9" class="empty">No projects yet. Onboard one.</td></tr>`;
  };
  $("refreshBtn").addEventListener("click", load);
  $("onbBtn").addEventListener("click", () => { $("onbCard").hidden = !$("onbCard").hidden; });
  $("onbForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries([...new FormData(ev.target)].filter(([, v]) => String(v).trim()).map(([k, v]) => [k, String(v).trim()]));
    const out = $("onbOut");
    out.hidden = false; out.textContent = ""; $("onbGo").disabled = true;
    try {
      const res = await fetch("/api/projects/onboard", { method: "POST", headers: { "content-type": "application/json", "x-mr-dashboard": "1" }, body: JSON.stringify(body) });
      if (!res.ok) { out.textContent = (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`; return; }
      const reader = res.body.getReader(); const dec = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) break; out.textContent += dec.decode(value, { stream: true }); out.scrollTop = out.scrollHeight; }
    } catch (e) { out.textContent += `\n${e.message}`; }
    finally { $("onbGo").disabled = false; load(); }
  });
  await load();
  startPageRefresh(load);
}

/* ---------------- status pill + table rows ---------------- */
function pill(o) {
  const title = o.full && o.full !== o.label ? ` title="${esc(o.full)}"` : "";
  return `<span class="st ${esc(o.cls)}"${title}>${esc(o.label)}</span>`;
}
function ttaCell(r) {
  if (r.pending) return '<span class="st warn">waiting</span>';
  return r.ttaMs == null ? '<span class="mut">–</span>' : esc(fdur(r.ttaMs));
}
const TRACE_COLS = 9;
function traceRowHtml(r) {
  return `<tr data-id="${esc(r.id)}" tabindex="0">
    <td class="ts" title="${esc(new Date(r.createdAt).toISOString())}">${esc(fdate(r.createdAt))}<span class="mut">${esc(ago(r.createdAt))}</span></td>
    <td class="nmcell"><span class="p" title="${esc(r.prompt)}">${esc(r.prompt || "(no prompt)")}</span><span class="id">${esc(r.id)}</span></td>
    <td class="m">${esc(r.agent)}</td>
    <td>${pill(r.outcome)}</td>
    <td class="r">${esc(fdurOr(r.latencyMs))}</td>
    <td class="r">${ttaCell(r)}</td>
    <td class="r">${esc(ftok(r.tokens))}</td>
    <td class="r">${esc(r.toolCalls ?? "–")}</td>
    <td class="r">${esc(r.sandboxRuns ?? "–")}</td></tr>`;
}
function traceHeadHtml() {
  return `<thead><tr><th>Timestamp</th><th>Name</th><th>Agent</th><th>Status</th><th class="r">Latency</th><th class="r">Time to card</th><th class="r">Tokens</th><th class="r">Tool calls</th><th class="r">Sandbox runs</th></tr></thead>`;
}
function skeletonRows(cols, n = 5) {
  return Array.from({ length: n }, () => `<tr class="nodata-row">${Array.from({ length: cols }, (_, i) => `<td><span class="skel line" style="width:${i === 1 ? 80 : 60}%"></span></td>`).join("")}</tr>`).join("");
}
function bindRowNav(tbody) {
  tbody.addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = tr.dataset.href || traceHref(tr.dataset.id); });
  tbody.addEventListener("keydown", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr && e.key === "Enter") location.hash = tr.dataset.href || traceHref(tr.dataset.id); });
}

/* ---------------- dashboard ---------------- */
const KPI_DEFS = [
  { k: "runs", label: "Runs", href: "#/runs", sub: () => "migration-rehearsal agents" },
  { k: "applied", label: "Applied", sw: "applied", href: "#/runs?status=applied", sub: () => "committed to prod" },
  { k: "denied", label: "Denied", sw: "denied", href: "#/runs?status=denied", sub: () => "by a human" },
  { k: "refused", label: "Refused by server", sw: "refused", href: "#/runs?status=refused", sub: () => "by pgwarden" },
  { k: "pendingApprovals", label: "Pending approval", sw: "waiting", href: "#/approvals?d=pending", sub: () => "waiting on a human" },
  { k: "medianTtaMs", label: "Median time to approval card", fmt: (v) => fdurOr(v), sub: (k) => `agent working time · ${k.ttaN} run${k.ttaN === 1 ? "" : "s"}`, href: "#/approvals" },
  { k: "tokens", label: "Total tokens", fmt: ftok, sub: () => "rehearsal runs" },
];

async function renderDashboard() {
  const tok = routeSeq;
  setActiveNav("dashboard");
  document.title = "Dashboard · Migration Rehearsal";
  $("app").innerHTML = pageHead("Overview", "Dashboard") + `
    <div class="kpis" id="kpis">${KPI_DEFS.map((d) => `<div class="kpi"><span class="k">${esc(d.label)}</span><span class="skel big"></span><span class="skel line" style="width:70%"></span></div>`).join("")}</div>
    <div class="grid2">
      <section class="card"><header><h2>Runs by outcome over time</h2><span class="s">rehearsal runs per hour, local time</span></header><div class="body"><div class="chart" id="chHours"><div class="skel block"></div></div><div class="legend" id="lgHours"></div></div></section>
      <section class="card"><header><h2>Time to approval card</h2><span class="s">per run: prompt → agent asks a human (colour = the human's decision)</span></header><div class="body"><div class="chart" id="chTta"><div class="skel block"></div></div><div class="legend" id="lgTta"></div></div></section>
    </div>
    <section class="card flush" style="margin-top:8px"><header><h2>Recent traces</h2><span class="s">all agents</span><span class="sp"></span><a href="#/traces">View all traces</a></header>
      <div class="body"><div class="tbl"><table class="dtable">${traceHeadHtml()}<tbody id="rows">${skeletonRows(TRACE_COLS, 5)}</tbody></table></div></div></section>
    <div id="listMsg"></div>`;
  $("refreshBtn").addEventListener("click", () => load(false));
  bindRowNav($("rows"));
  let resizeT = null;
  const onResize = () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (tok === routeSeq && lastRows) drawCharts(lastRows); }, 120); };
  window.addEventListener("resize", onResize);
  const off = () => { window.removeEventListener("resize", onResize); window.removeEventListener("hashchange", off); };
  window.addEventListener("hashchange", off);

  async function load(quiet) {
    let rows;
    try { rows = await loadRows(); } catch (e) {
      if (tok !== routeSeq) return;
      if (!quiet || !lastRows) { $("listMsg").innerHTML = errorBanner(e); $("rows").innerHTML = `<tr class="nodata-row"><td colspan="${TRACE_COLS}" class="nodata">Could not load sessions.</td></tr>`; }
      return;
    }
    if (tok !== routeSeq) return;
    $("listMsg").innerHTML = "";
    const agg = aggregate(rows);
    $("kpis").innerHTML = KPI_DEFS.map((d) => {
      const v = agg.kpis[d.k];
      const text = d.fmt ? d.fmt(v) : String(v ?? "–");
      const tag = d.href ? "a" : "div";
      return `<${tag} class="kpi"${d.href ? ` href="${d.href}"` : ""}><span class="k">${d.sw ? `<span class="sw ${d.sw}"></span>` : ""}${esc(d.label)}</span><span class="v">${esc(text)}</span><span class="s">${esc(d.sub(agg.kpis))}</span></${tag}>`;
    }).join("");
    $("rows").innerHTML = rows.length ? rows.slice(0, 5).map(traceRowHtml).join("") : `<tr class="nodata-row"><td colspan="${TRACE_COLS}" class="nodata">No sessions yet. Run the <span class="mono">migration-rehearsal</span> agent in TrueForge.</td></tr>`;
    drawCharts(rows, agg);
    setUpdated();
  }
  await load(false);
  if (tok === routeSeq) startPageRefresh(load);
}

function drawCharts(rows, agg = aggregate(rows)) {
  const h = $("chHours"), t = $("chTta");
  if (h) { h.innerHTML = hoursChart(agg, h.clientWidth || 600); }
  if (t) { t.innerHTML = ttaChart(agg, t.clientWidth || 600); }
  const present = OUTCOMES.filter((o) => agg.hours.some((x) => x.counts[o.key]));
  const lg = $("lgHours");
  if (lg) lg.innerHTML = (present.length ? present : OUTCOMES.slice(0, 3)).map((o) => `<span><span class="sw ${o.key}"></span>${esc(o.label)}</span>`).join("") + (agg.outOfRange ? `<span>${agg.outOfRange} older run${agg.outOfRange === 1 ? "" : "s"} not shown</span>` : "");
  const lt = $("lgTta");
  if (lt) lt.innerHTML = agg.tta.length ? `<span><span class="sw applied"></span>allowed</span><span><span class="sw denied"></span>denied</span><span><svg width="18" height="9" aria-hidden="true"><line x1="0" y1="4.5" x2="18" y2="4.5" style="stroke:var(--ink2);stroke-dasharray:3 3"/></svg>median</span>` : "";
}

const svgEsc = esc;
function niceStep(max, target = 4) {
  const raw = max / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
function hoursChart(agg, W) {
  const hours = agg.hours;
  if (!hours.some((x) => x.total)) return `<div class="chart-empty">No rehearsal runs in the last ${hours.length} hours.</div>`;
  const H = 240, ml = 32, mr = 8, mt = 12, mb = 28;
  const iw = Math.max(W - ml - mr, 50), ih = H - mt - mb;
  const maxV = Math.max(...hours.map((x) => x.total), 1);
  const step = Math.max(1, Math.ceil(niceStep(maxV, 4)));
  const top = Math.ceil(maxV / step) * step;
  const y = (v) => mt + ih - (v / top) * ih;
  const bw = iw / hours.length;
  const barW = Math.max(Math.min(bw * 0.6, 40), 2);
  let g = "";
  for (let v = 0; v <= top; v += step) g += `<line class="grid" x1="${ml}" x2="${ml + iw}" y1="${y(v)}" y2="${y(v)}"/><text x="${ml - 6}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
  const labelEvery = Math.max(1, Math.ceil(hours.length / Math.max(1, Math.floor(iw / 44))));
  hours.forEach((hr, i) => {
    const cx = ml + bw * i + bw / 2;
    let acc = 0;
    for (const o of OUTCOMES) {
      const c = hr.counts[o.key];
      if (!c) continue;
      const y1 = y(acc + c), y0 = y(acc);
      g += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(y0 - y1 - 1, 1).toFixed(1)}" rx="2" style="fill:var(--c-${o.key})"><title>${svgEsc(`${hourLabel(hr.t)}: ${c} ${o.label}`)}</title></rect>`;
      acc += c;
    }
    if (hr.total) g += `<text x="${cx}" y="${y(hr.total) - 4}" text-anchor="middle" class="lbl-ink">${hr.total}</text>`;
    if (i % labelEvery === 0 || i === hours.length - 1) g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${svgEsc(hourLabel(hr.t))}</text>`;
  });
  g += `<line class="axis" x1="${ml}" x2="${ml + iw}" y1="${y(0)}" y2="${y(0)}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Runs by outcome per hour">${g}</svg>`;
}
const hourLabel = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function durTicks(max, maxTicks = 5) {
  const steps = [1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 14400e3];
  const step = steps.find((s) => max / s <= maxTicks) ?? Math.ceil(max / maxTicks / 3600e3) * 3600e3;
  const out = [];
  for (let v = 0; v <= max + 1; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
const fdurShort = (v) => v === 0 ? "0" : v < 60e3 ? Math.round(v / 1000) + "s" : v < 3600e3 ? Math.round(v / 60e3) + "m" : (v / 3600e3).toFixed(v % 3600e3 ? 1 : 0) + "h";

function ttaChart(agg, W) {
  const list = agg.tta;
  if (!list.length) return `<div class="chart-empty">No approval decisions yet.<br>Decisions made in TrueForge show up here.</div>`;
  const rowH = 26, ml = 148, mr = 72, mt = 8, mb = 26;
  const H = mt + mb + rowH * list.length;
  const iw = Math.max(W - ml - mr, 60);
  const ticks = durTicks(Math.max(...list.map((a) => a.waitMs), 1000), Math.max(2, Math.min(6, Math.floor(iw / 56))));
  const max = ticks[ticks.length - 1];
  const x = (v) => ml + (v / max) * iw;
  let g = "";
  for (const v of ticks) g += `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${mt}" y2="${H - mb}"/><text x="${x(v)}" y="${H - 8}" text-anchor="middle">${fdurShort(v)}</text>`;
  const med = agg.kpis.medianTtaMs;
  if (med != null) g += `<line class="medl" x1="${x(med)}" x2="${x(med)}" y1="${mt - 4}" y2="${H - mb}"><title>median ${svgEsc(fdur(med))}</title></line>`;
  list.forEach((a, i) => {
    const yc = mt + rowH * i + rowH / 2;
    const ok = a.decision === "allow";
    const res = a.result?.status === "refused" ? ` · refused${a.result.code ? " " + a.result.code : ""}` : a.result?.status === "committed" ? " · committed" : "";
    const tip = `${a.sessionId}\napproval card after ${fdur(a.waitMs)} · ${ok ? "allowed" : a.decision === "deny" ? "denied" : a.decision}${res}`;
    const w = Math.max(x(a.waitMs) - ml, 2);
    g += `<a href="${traceHref(a.sessionId)}"><rect class="hit" x="0" y="${yc - rowH / 2}" width="${W}" height="${rowH}"/>
      <text x="${ml - 8}" y="${yc + 3.5}" text-anchor="end" class="mono lbl-ink">${svgEsc(short(a.sessionId))}</text>
      <rect x="${ml}" y="${yc - 6}" width="${w.toFixed(1)}" height="12" rx="2" style="fill:var(--c-${ok ? "applied" : "denied"})"/>
      <text x="${ml + w + 6}" y="${yc + 3.5}" class="lbl-ink">${svgEsc(fdur(a.waitMs))}</text>
      <title>${svgEsc(tip)}</title></a>`;
  });
  g += `<line class="axis" x1="${ml}" x2="${ml}" y1="${mt}" y2="${H - mb}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Time to approval per decision">${g}</svg>`;
}

/* ---------------- traces / rehearsals list ---------------- */
const listUi = { q: "", status: "all" };
async function renderTraceList(kind) {
  const tok = routeSeq;
  const rehearsals = kind === "runs";
  setActiveNav(kind);
  document.title = `${rehearsals ? "Runs" : "Traces"} · Migration Rehearsal`;
  const qs = new URLSearchParams(location.hash.split("?")[1] || "");
  listUi.status = qs.get("status") || "all";
  $("app").innerHTML = pageHead("Tracing", rehearsals ? "Runs" : "Traces") + `
    <div class="toolbar">
      <label class="search"><svg class="i" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg><input id="q" type="search" placeholder="Search name or id" value="${esc(listUi.q)}" aria-label="Search traces"></label>
      <div class="fchips" id="fchips" role="group" aria-label="Filter by status"></div>
    </div>
    <div class="tbl"><table class="dtable">${traceHeadHtml()}<tbody id="rows">${skeletonRows(TRACE_COLS, 8)}</tbody></table></div>
    <div class="tfoot"><span id="countNote"></span><span>${rehearsals ? `<span class="mono">migration-rehearsal</span> agents only` : "all agents"}</span></div>
    <div id="listMsg"></div>`;
  $("refreshBtn").addEventListener("click", () => load(false));
  bindRowNav($("rows"));
  let rowsAll = [];
  const draw = () => {
    const q = listUi.q.trim().toLowerCase();
    const counts = Object.fromEntries(OUTCOMES.map((o) => [o.key, 0]));
    const base = rowsAll.filter((r) => !q || r.prompt.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.agent.toLowerCase().includes(q));
    for (const r of base) counts[r.outcome.key] = (counts[r.outcome.key] || 0) + 1;
    const vis = listUi.status === "all" ? base : base.filter((r) => r.outcome.key === listUi.status);
    $("fchips").innerHTML = `<button type="button" class="fchip" data-s="all" aria-pressed="${listUi.status === "all"}">All <span class="n">${base.length}</span></button>` +
      OUTCOMES.filter((o) => counts[o.key] || listUi.status === o.key || ["applied", "denied", "refused", "waiting"].includes(o.key)).map((o) => `<button type="button" class="fchip" data-s="${o.key}" aria-pressed="${listUi.status === o.key}"><span class="sw ${o.key}"></span>${esc(o.label)} <span class="n">${counts[o.key] || 0}</span></button>`).join("");
    $("rows").innerHTML = vis.length ? vis.map(traceRowHtml).join("") : `<tr class="nodata-row"><td colspan="${TRACE_COLS}" class="nodata">${rowsAll.length ? "No traces match the filter." : "No sessions yet."}</td></tr>`;
    $("countNote").textContent = `${vis.length} of ${rowsAll.length} ${rehearsals ? "runs" : "traces"}`;
  };
  $("q").addEventListener("input", (e) => { listUi.q = e.target.value; draw(); });
  $("fchips").addEventListener("click", (e) => { const b = e.target.closest("[data-s]"); if (!b) return; listUi.status = b.dataset.s; draw(); });
  async function load(quiet) {
    let rows;
    try { rows = await loadRows(); } catch (e) {
      if (tok !== routeSeq) return;
      if (!quiet || !lastRows) { $("listMsg").innerHTML = errorBanner(e); $("rows").innerHTML = `<tr class="nodata-row"><td colspan="${TRACE_COLS}" class="nodata">Could not load sessions.</td></tr>`; }
      return;
    }
    if (tok !== routeSeq) return;
    $("listMsg").innerHTML = "";
    rowsAll = rehearsals ? rows.filter((r) => r.isRehearsal) : rows;
    draw();
    setUpdated();
  }
  await load(false);
  if (tok === routeSeq) startPageRefresh(load);
}

/* ---------------- approvals ---------------- */
const apprUi = { d: "all" };
async function renderApprovals() {
  const tok = routeSeq;
  setActiveNav("approvals");
  document.title = "Approvals · Migration Rehearsal";
  const qs = new URLSearchParams(location.hash.split("?")[1] || "");
  apprUi.d = qs.get("d") || "all";
  $("app").innerHTML = pageHead("Tracing", "Approvals") + `
    <div class="kpis" id="akpis" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:16px">${[0, 1, 2, 3].map(() => `<div class="kpi"><span class="skel line" style="width:50%"></span><span class="skel big"></span></div>`).join("")}</div>
    <div class="toolbar"><div class="fchips" id="afchips" role="group" aria-label="Filter by decision"></div><span class="sp"></span><span class="meta-note">Approvals are decided in TrueForge. This page only reads them.</span></div>
    <div class="tbl"><table class="dtable"><thead><tr><th>Requested</th><th>Tool</th><th>Decision</th><th>Reason</th><th class="r">Time to decision</th><th>Result</th><th>Trace</th></tr></thead><tbody id="rows">${skeletonRows(7, 5)}</tbody></table></div>
    <div id="listMsg"></div>`;
  $("refreshBtn").addEventListener("click", () => load(false));
  bindRowNav($("rows"));
  let all = [];
  const decLabel = (d) => d === "allow" ? ["allowed", "ok"] : d === "deny" ? ["denied", "bad"] : d === "pending" ? ["pending", "warn"] : [d, "idle"];
  const resultHtml = (a) => {
    if (a.decision === "pending") return '<span class="mut">waiting on decision</span>';
    const r = a.result;
    if (!r) return '<span class="mut">–</span>';
    if (r.status === "committed") return '<span class="st ok">committed</span>';
    if (r.status === "refused") return `<span class="st refused">refused</span>${r.code ? ` <span class="mono mut" style="font-size:11px">${esc(r.code)}</span>` : ""}`;
    if (r.status === "denied") return '<span class="mut">not executed</span>';
    if (r.status === "ok") return '<span class="st ok">ok</span>';
    return `<span class="st err">${esc(r.code || r.status)}</span>`;
  };
  const draw = () => {
    const counts = { all: all.length, pending: 0, allow: 0, deny: 0 };
    for (const a of all) counts[a.decision] = (counts[a.decision] || 0) + 1;
    const vis = apprUi.d === "all" ? all : all.filter((a) => a.decision === apprUi.d);
    $("afchips").innerHTML = [["all", "All"], ["pending", "Pending"], ["allow", "Allowed"], ["deny", "Denied"]].map(([k, l]) => `<button type="button" class="fchip" data-d="${k}" aria-pressed="${apprUi.d === k}">${k === "pending" ? '<span class="sw waiting"></span>' : k === "allow" ? '<span class="sw applied"></span>' : k === "deny" ? '<span class="sw denied"></span>' : ""}${l} <span class="n">${counts[k] || 0}</span></button>`).join("");
    $("rows").innerHTML = vis.length ? vis.map((a) => {
      const [dl, dc] = decLabel(a.decision);
      return `<tr data-id="${esc(a.sessionId)}" data-href="${esc(traceHref(a.sessionId, a.id))}" tabindex="0">
        <td class="ts" title="${esc(a.requestedAt ? new Date(a.requestedAt).toISOString() : "")}">${esc(a.requestedAt ? fdate(a.requestedAt) : "–")}<span class="mut">${esc(a.requestedAt ? ago(a.requestedAt) : "")}</span></td>
        <td class="m">${esc(a.tool || "tool call")}</td>
        <td><span class="st ${dc}">${esc(dl)}</span></td>
        <td class="reason">${a.reason ? esc(a.reason) : '<span class="mut">–</span>'}</td>
        <td class="r">${a.decision === "pending" ? esc(fdur(Math.max(0, Date.now() - (a.requestedAt ?? Date.now())))) + " <span class=\"mut\">so far</span>" : esc(fdurOr(a.waitMs))}</td>
        <td>${resultHtml(a)}</td>
        <td class="nmcell" style="min-width:160px;max-width:280px"><span class="p" title="${esc(a.prompt)}">${esc(a.prompt || "(no prompt)")}</span><span class="id">${esc(short(a.sessionId))}</span></td></tr>`;
    }).join("") : `<tr class="nodata-row"><td colspan="7" class="nodata">${all.length ? "No approvals match the filter." : "No approval requests yet."}</td></tr>`;
  };
  $("afchips").addEventListener("click", (e) => { const b = e.target.closest("[data-d]"); if (!b) return; apprUi.d = b.dataset.d; draw(); });
  async function load(quiet) {
    let rows;
    try { rows = await loadRows(); } catch (e) {
      if (tok !== routeSeq) return;
      if (!quiet || !lastRows) { $("listMsg").innerHTML = errorBanner(e); $("rows").innerHTML = `<tr class="nodata-row"><td colspan="7" class="nodata">Could not load sessions.</td></tr>`; }
      return;
    }
    if (tok !== routeSeq) return;
    $("listMsg").innerHTML = "";
    all = rows.flatMap((r) => r.approvals.map((a) => ({ ...a, prompt: r.prompt })))
      .sort((a, b) => (b.decision === "pending") - (a.decision === "pending") || (b.requestedAt ?? 0) - (a.requestedAt ?? 0));
    const decided = all.filter((a) => a.waitMs != null).map((a) => a.waitMs).sort((x, y) => x - y);
    const med = decided.length ? (decided.length % 2 ? decided[decided.length >> 1] : (decided[decided.length / 2 - 1] + decided[decided.length / 2]) / 2) : null;
    const n = (d) => all.filter((a) => a.decision === d).length;
    $("akpis").innerHTML = [
      ["Pending", n("pending"), "waiting", "waiting on a human"],
      ["Allowed", n("allow"), "applied", "approved in TrueForge"],
      ["Denied", n("deny"), "denied", "rejected in TrueForge"],
      ["Median time to decision", fdurOr(med), "", `request → human decision · ${decided.length} decision${decided.length === 1 ? "" : "s"} (incl. automated test runs)`],
    ].map(([k, v, sw, s]) => `<div class="kpi"><span class="k">${sw ? `<span class="sw ${sw}"></span>` : ""}${esc(k)}</span><span class="v">${esc(v)}</span><span class="s">${esc(s)}</span></div>`).join("");
    draw();
    setUpdated();
  }
  await load(false);
  if (tok === routeSeq) startPageRefresh(load);
}
/* ---------------- trace view ---------------- */

async function renderTrace(sid, obsId) {
  setActiveNav("traces");
  const fresh = state.sessionId !== sid;
  if (fresh) Object.assign(state, { sessionId: sid, session: null, mapped: null, selected: null, follow: true, dtab: "output", lastCount: -1 });
  if (obsId) { state.selected = obsId; state.follow = false; }
  const app = $("app");
  app.innerHTML = `<div class="crumb"><a href="#/traces">Traces</a><span>/</span><b id="sid">${esc(sid)}</b></div>
    <div class="thead"><h1 id="title">Loading…</h1><span class="st idle" id="status">–</span><div class="chips" id="hchips"></div><span style="flex:1"></span><a class="btn" id="chatBtn" target="_blank" rel="noopener" href="${esc(chatUrl(sid))}">Open chat in TrueForge</a></div>
    <div class="prod" id="prod"></div>
    <details class="smeta" id="smeta"${metaOpen() ? " open" : ""}><summary>Metadata</summary><dl class="kv" id="smetaBody"></dl></details>
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
    setSource(state.mapped.summary.running ? "run" : "on", FIXTURE ? liveText() : state.mapped.summary.running ? "live · following turn" : "live · TrueForge");
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
  document.title = `${ses.title || "Session"} · Migration Rehearsal`;
  renderSessionMeta();
  // keep the sidebar badge current while following a trace (other sessions from the last list load)
  setApprBadge((lastRows || []).filter((r) => r.id !== state.sessionId).reduce((n, r) => n + (r.pending || 0), 0) + s.pendingApprovals.length);
  $("title").textContent = ses.title || `session ${short(state.sessionId)}`;
  const st = $("status"); st.textContent = s.status; st.className = "st " + s.statusClass;
  const cost = ses.metrics?.total_cost_in_usd ?? s.costUsd;
  $("hchips").innerHTML = [
    ["agent", ses.agent?.name ?? "–"],
    ["turns", s.turns],
    ["latency", fdur(ses.metrics?.total_duration_ms || s.durationMs)],
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
  $("rehearsals").innerHTML = reps.length ? `<span class="lbl mut" style="font-size:11.5px">attempts</span>` + reps.map((r) => {
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
  return `<div class="sec"><span class="l">Run report · attempt ${esc(r.attempt ?? "?")} · verdict <span class="${ok ? "ok" : "bad"}">${esc(r.verdict)}</span>${r.duration_ms != null ? " · " + esc(fdur(r.duration_ms)) : ""}${r.source_rows ? " · source rows " + esc(Object.entries(r.source_rows).map(([k, v]) => `${k} ${Number(v).toLocaleString()}`).join(", ")) : ""}</span>
    <div class="tbl"><table><thead><tr><th>check</th><th>target</th><th class="r">time</th><th>result</th></tr></thead><tbody>${rows.map(([a, b, c, okk, err]) => `<tr><td>${esc(a)}</td><td class="m">${esc(b)}${err ? `<div class="bad" style="white-space:pre-wrap">${esc(err)}</div>` : ""}</td><td class="r">${esc(c)}</td><td class="${okk ? "ok" : "bad"}">${okk ? "pass" : "fail"}</td></tr>`).join("")}</tbody></table></div></div>
    ${eff ? `<div class="sec"><span class="l">effects (row_deltas + schema_changes)</span><div class="tbl"><table><tbody>${Object.entries(eff.row_deltas || {}).map(([k, v]) => `<tr><td class="m">${esc(k)}</td><td class="r">${v > 0 ? "+" : ""}${esc(v)}</td></tr>`).join("")}${(eff.schema_changes || []).map((c) => `<tr><td class="m" colspan="2">${esc(c)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
    <details><summary>raw report JSON</summary><pre class="box">${jsonHtml(r)}</pre></details>`;
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
  const server = String(n.toolName || "").split(".")[0];
  const rv = typeof a.sql === "string" ? reviewMigration({ sql: a.sql, effects: a.declared_effects, protectedTables: protectedByServer[server] || [] }) : null;
  const review = rv ? `<div class="review ${rv.verdict}">
      <div class="rv-head"><span class="st ${rv.verdict === "allow" ? "ok" : rv.verdict === "deny" ? "bad" : "warn"}">${rv.verdict === "allow" ? "recommend: allow" : rv.verdict === "deny" ? "recommend: deny" : "review carefully"}</span><b>${esc(rv.headline)}</b></div>
      ${rv.reasons.length ? `<ul class="rv-reasons">${rv.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <div class="rv-l">What this migration will do</div>
      <ol class="rv-steps">${rv.statements.map((s) => `<li><span class="rv-risk ${s.risk}">${s.risk}</span>${esc(s.text)}</li>`).join("")}</ol>
      <div class="note">Review assist: computed from the SQL, the declared effects and this project's protected tables${(protectedByServer[server] || []).length ? ` (${esc(protectedByServer[server].join(", "))})` : ""}. Not written by the agent.</div>
    </div>` : "";
  return `<div class="gatebox${waiting ? "" : " done"}">${head}
    ${review}
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

/* ---------------- session metadata (trace header) ---------------- */
function metaOpen() { try { return localStorage.getItem("dr-meta") === "open"; } catch { return false; } }
function renderSessionMeta() {
  const box = $("smetaBody");
  if (!box || !state.mapped) return;
  const ses = state.session || {};
  const s = state.mapped.summary;
  const pr = repoPrFromText(ses.title || state.mapped.traces[0]?.input?.v || "");
  setPrLink(pr);
  const rows = [
    ["session", state.sessionId],
    ["agent", ses.agent?.name ?? (ses.agent?.type || "–")],
    ["created", ses.created_at ? `${fdate(ses.created_at)} (${ago(ses.created_at)})` : "–"],
    ["updated", ses.updated_at ? fdate(ses.updated_at) : "–"],
    ["repo", pr.repo ?? "–"],
    ["pull request", pr.url ? { href: pr.url, text: `#${pr.pr}` } : "–"],
    ["turns", s.turns],
    ["harness time", fdurOr(ses.metrics?.total_duration_ms)],
    ["wall clock", fdurOr(s.durationMs)],
    ["tokens in / out", `${ftok(s.tokensIn)} / ${ftok(s.tokensOut)}`],
    ["cost", fusd(ses.metrics?.total_cost_in_usd ?? s.costUsd)],
    ["created by", ses.created_by_subject?.subject_display_name ?? "–"],
  ];
  if (ses.metadata && Object.keys(ses.metadata).length) rows.push(["metadata", JSON.stringify(ses.metadata)]);
  box.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v && typeof v === "object" ? `<a href="${esc(v.href)}" target="_blank" rel="noopener">${esc(v.text)}</a>` : esc(v)}</dd>`).join("");
}

/* ---------------- routing ---------------- */
async function route() {
  stopPolling();
  routeSeq++;
  closeMenu();
  const h = location.hash || "#/";
  const m = /^#\/s\/([^?]+)(?:\?o=(.+))?$/.exec(h);
  if (m) return renderTrace(decodeURIComponent(m[1]), m[2] ? decodeURIComponent(m[2]) : null);
  state.sessionId = null;
  setPrLink(lastRows?.find((r) => r.isRehearsal && r.url) || lastRows?.find((r) => r.url) || null);
  if (FIXTURE && !location.hash) { const f = await loadFixture(); location.replace("#/s/" + f.session.id); return; }
  const path = h.slice(1).split("?")[0];
  if (path === "/traces") return renderTraceList("traces");
  if (path === "/runs" || path === "/rehearsals") return renderTraceList("runs");
  if (path === "/approvals") return renderApprovals();
  if (path === "/projects") return renderProjects();
  return renderDashboard();
}

/* ---------------- sidebar ---------------- */
function closeMenu() { $("shell").classList.remove("open"); $("menuBtn").setAttribute("aria-expanded", "false"); }
function initSidebar() {
  const root = document.documentElement;
  const setCollapsed = (c) => {
    if (c) root.setAttribute("data-side", "collapsed"); else root.removeAttribute("data-side");
    try { localStorage.setItem("dr-side", c ? "collapsed" : "expanded"); } catch {}
    $("collapseBtn").title = c ? "Expand sidebar" : "Collapse sidebar";
    $("collapseBtn").setAttribute("aria-label", $("collapseBtn").title);
    if (lastRows && $("chHours")) setTimeout(() => drawCharts(lastRows), 0);
  };
  $("collapseBtn").addEventListener("click", () => setCollapsed(root.getAttribute("data-side") !== "collapsed"));
  $("collapseBtn").title = root.getAttribute("data-side") === "collapsed" ? "Expand sidebar" : "Collapse sidebar";
  $("menuBtn").addEventListener("click", () => { const open = !$("shell").classList.contains("open"); $("shell").classList.toggle("open", open); $("menuBtn").setAttribute("aria-expanded", String(open)); });
  $("scrim").addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  $("side").addEventListener("click", (e) => { if (e.target.closest("a.nav")) closeMenu(); });
  document.addEventListener("toggle", (e) => { if (e.target.id === "smeta") { try { localStorage.setItem("dr-meta", e.target.open ? "open" : "closed"); } catch {} } }, true);
}

(async function init() {
  try { cfg = { ...cfg, ...(await (await fetch("/config.json")).json()) }; } catch {}
  $("tfLink").href = cfg.trueforgeUi;
  initSidebar();
  window.addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.sessionId && timer) { clearTimeout(timer); refreshTrace(false); } });
  route();
})();
