import { createPool } from "./db.js";
import { loadEnv } from "./env.js";
import { createHttpServer } from "./http.js";
import { createMasker } from "./mask.js";
import { ensureParser } from "./policy.js";

const env = loadEnv();
const pool = createPool(env.databaseUrl);
await ensureParser();
await pool.query("SELECT 1"); // fail fast if prod is unreachable

const protectedTables = (process.env.PGWARDEN_PROTECT ?? "").split(",").map((t) => t.trim()).filter(Boolean);
const http = createHttpServer({ pool, masker: createMasker(env.maskKey), protectedTables }, env.token);
http.listen(env.port, () => {
  console.log(`[pgwarden] listening on http://localhost:${env.port}/mcp (bearer auth required)${protectedTables.length ? `; protected: ${protectedTables.join(", ")}` : ""}`);
});

const shutdown = () => {
  http.close();
  pool.end().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
