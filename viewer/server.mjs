#!/usr/bin/env node
// Migration Rehearsal trace viewer: a read-only window onto TrueForge sessions.
// Serves viewer/public on :8795 and proxies GET /tf/* -> ${TRUEFORGE_BASE_URL}/*.
// The proxy is GET-only on purpose: the viewer can never create turns or send approvals.
// Approvals happen in the TrueForge chat UI.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const FIXTURES = join(HERE, "fixtures");
const PORT = Number(process.env.VIEWER_PORT || 8795);
const HOST = process.env.VIEWER_HOST || "127.0.0.1";
const TF = (process.env.TRUEFORGE_BASE_URL || "http://localhost:8790").replace(/\/+$/, "");
// Where a browser should open the TrueForge chat (defaults to the same base URL).
const TF_UI = (process.env.TRUEFORGE_UI_URL || TF).replace(/\/+$/, "");
const TOKEN = process.env.TRUEFORGE_TOKEN || "";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

async function serveFile(res, root, rel) {
  const p = normalize(join(root, rel));
  if (!p.startsWith(root)) return send(res, 403, "forbidden");
  try {
    const s = await stat(p);
    if (!s.isFile()) return send(res, 404, "not found");
    res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(p));
  } catch { send(res, 404, "not found"); }
}
function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function proxy(req, res, path) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, JSON.stringify({ error: "viewer is read-only; decide approvals in TrueForge" }), "application/json");
  }
  const target = TF + path;
  const headers = { accept: req.headers.accept || "*/*" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  else if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  try {
    const up = await fetch(target, { method: req.method, headers, signal: ac.signal });
    const h = { "cache-control": "no-store" };
    for (const k of ["content-type", "content-disposition", "content-length"]) { const v = up.headers.get(k); if (v) h[k] = v; }
    if ((h["content-type"] || "").includes("text/event-stream")) { h["x-accel-buffering"] = "no"; delete h["content-length"]; }
    res.writeHead(up.status, h);
    if (!up.body || req.method === "HEAD") return res.end();
    Readable.fromWeb(up.body).on("error", () => res.end()).pipe(res);
  } catch (e) {
    if (ac.signal.aborted) return;
    send(res, 502, JSON.stringify({ error: `TrueForge unreachable at ${TF}`, detail: String(e?.cause?.code || e?.message || e) }), "application/json");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/tf" || p.startsWith("/tf/")) return proxy(req, res, p.slice(3) + url.search);
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "read-only");
  if (p === "/config.json") return send(res, 200, JSON.stringify({ trueforgeUi: TF_UI, trueforgeApi: TF }), "application/json");
  if (p.startsWith("/fixtures/")) return serveFile(res, FIXTURES, p.slice("/fixtures/".length));
  return serveFile(res, PUBLIC, p === "/" ? "index.html" : p.slice(1));
});

server.listen(PORT, HOST, () => {
  console.log(`Migration Rehearsal trace viewer on http://localhost:${PORT}  (TrueForge: ${TF}, read-only proxy at /tf)`);
  console.log(`Fixture: http://localhost:${PORT}/?fixture=1`);
});
