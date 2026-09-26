// Projects API for the dashboard: list onboarded projects with their health, and onboard a new one.
// Onboarding runs the same `scripts/onboard.ts` as the CLI and streams its output. Secrets never pass
// through here: the form takes the NAME of the .env variable that holds a project's database URL.
// Write endpoints need JSON + the x-mr-dashboard header, so a cross-site form or fetch can't trigger them
// (that combination forces a CORS preflight, which this server never answers).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = join(ROOT, "projects");
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{1,60}$/;
const PATH_RE = /^[\w./-]{1,100}$/;

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

function listProjects() {
  if (!existsSync(PROJECTS)) return [];
  return readdirSync(PROJECTS).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(PROJECTS, f), "utf8")));
}

const portUp = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(800, () => done(false));
  s.once("connect", () => done(true));
  s.once("error", () => done(false));
});

// gh lookups are slow and rate-limited: cache per repo for a minute.
const ghCache = new Map();
function gh(args) {
  return new Promise((resolve) => {
    const p = spawn("gh", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    p.on("error", () => resolve(null));
  });
}
async function repoHealth(p) {
  const hit = ghCache.get(p.repo);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const [wf, runners] = await Promise.all([
    gh(["api", `repos/${p.repo}/contents/.github/workflows/migration-rehearsal.yml`, "--jq", ".sha"]),
    gh(["api", `repos/${p.repo}/actions/runners`, "--jq", `[.runners[] | select(.status == "online") | select([.labels[].name] | index("${p.runner_label}"))] | length`]),
  ]);
  const v = { workflow: !!wf, runners_online: runners == null ? null : Number(runners) };
  ghCache.set(p.repo, { at: Date.now(), v });
  return v;
}

async function projectsWithHealth(tf) {
  const agents = await tf("/api/v1/agents?limit=100").then((b) => (b?.data || []).map((a) => a.name)).catch(() => null);
  const sessions = [];
  let next = "";
  for (let page = 0; page < 8; page++) { // TrueForge pages sessions 25 at a time, newest first
    const b = await tf(`/api/v1/sessions?limit=25${next ? `&page_token=${encodeURIComponent(next)}` : ""}`).catch(() => null);
    sessions.push(...(b?.data || []));
    next = b?.pagination?.next_page_token;
    if (!next) break;
  }
  return Promise.all(listProjects().map(async (p) => {
    const mine = sessions.filter((s) => s.agent?.name === p.agent);
    return {
      ...p,
      masked_columns: p.mask ? p.mask.split(",").map((x) => x.split(":")[0]) : [],
      health: {
        pgwarden_up: await portUp(p.pgwarden.port),
        agent_registered: agents ? agents.includes(p.agent) : null,
        ...(await repoHealth(p)),
      },
      runs: mine.length,
      last_run: mine[0] ? { id: mine[0].id, at: mine[0].created_at, title: mine[0].title } : null,
    };
  }));
}

function run(res, args) {
  return new Promise((resolve) => {
    const p = spawn("npx", ["tsx", ...args], { cwd: ROOT, env: { ...process.env, FORCE_COLOR: "0" } });
    p.stdout.on("data", (d) => res.write(d));
    p.stderr.on("data", (d) => res.write(d));
    p.on("close", (code) => resolve(code));
    p.on("error", (e) => { res.write(`\n${e.message}\n`); resolve(1); });
  });
}

function startPgwarden(name) {
  const child = spawn("npx", ["tsx", "scripts/pgwarden-project.ts", name], { cwd: ROOT, detached: true, stdio: "ignore" });
  child.unref();
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 10_000) throw new Error("body too large"); }
  return JSON.parse(body || "{}");
}

/** Returns true when the request was handled. `tf(path)` GETs TrueForge JSON. */
export async function handleProjects(req, res, path, tf) {
  if (path === "/api/projects" && req.method === "GET") {
    json(res, 200, { data: await projectsWithHealth(tf) });
    return true;
  }
  if (path === "/api/projects/onboard" && req.method === "POST") {
    if (!(req.headers["content-type"] || "").startsWith("application/json") || req.headers["x-mr-dashboard"] !== "1") {
      json(res, 403, { error: "forbidden" });
      return true;
    }
    let b;
    try { b = await readJson(req); } catch (e) { json(res, 400, { error: String(e.message) }); return true; }
    const bad = [
      !NAME_RE.test(b.project || "") && "project: lowercase letters, digits and hyphens",
      b.repo && !REPO_RE.test(b.repo) && "repo: owner/name",
      b.dbEnv && !ENV_RE.test(b.dbEnv) && "database variable: an UPPER_CASE .env variable name (not the URL)",
      b.migrations && !PATH_RE.test(b.migrations) && "migrations path",
      b.queries && !PATH_RE.test(b.queries) && "queries path",
    ].filter(Boolean);
    if (bad.length) { json(res, 400, { error: `invalid: ${bad.join("; ")}` }); return true; }
    const args = ["scripts/onboard.ts", "--project", b.project];
    if (b.repo) args.push("--repo", b.repo);
    if (b.dbEnv) args.push("--db-env", b.dbEnv);
    if (b.migrations) args.push("--migrations", b.migrations);
    if (b.queries) args.push("--queries", b.queries);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
    res.write(`$ npm run onboard -- ${args.slice(1).join(" ")}\n\n`);
    let code = await run(res, args);
    // A new project's pgwarden can only start once its config exists: start it, then re-check.
    const p = listProjects().find((x) => x.name === b.project);
    if (p && !(await portUp(p.pgwarden.port))) {
      res.write(`\nStarting pgwarden for ${p.name} on :${p.pgwarden.port}…\n`);
      startPgwarden(p.name);
      for (let i = 0; i < 20 && !(await portUp(p.pgwarden.port)); i++) await new Promise((r) => setTimeout(r, 500));
      res.write(`Re-checking…\n\n`);
      code = await run(res, ["scripts/onboard.ts", "--project", p.name]);
    }
    ghCache.delete(p?.repo);
    res.end(`\n[exit ${code}]\n`);
    return true;
  }
  return false;
}
