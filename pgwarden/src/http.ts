import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, type Deps } from "./tools.js";

function authorized(req: IncomingMessage, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1].trim()), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/** Stateless Streamable HTTP at /mcp: a fresh McpServer + transport per request, bearer auth on everything. */
export function createHttpServer(deps: Deps, token: string): Server {
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!authorized(req, token)) {
      console.log(`[pgwarden] http ${req.method} ${path} -> 401`);
      return json(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "UNAUTHORIZED: missing or invalid bearer token" }, id: null });
    }
    if (path !== "/mcp") return json(res, 404, { error: "not found; the MCP endpoint is /mcp" });
    if (req.method !== "POST") {
      return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null });
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
    const server = buildServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error(`[pgwarden] request failed: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
}
