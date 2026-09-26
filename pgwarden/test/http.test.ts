import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "../src/http.js";
import { createMasker } from "../src/mask.js";
import { createPool, dropDb, freshDb, seedMiniProd, type Pool } from "./helpers.js";

const DB = "pgwarden_test_http";
const TOKEN = "test-token-0123456789abcdef0123456789";

export const EXPECTED_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  describe_schema: { readOnlyHint: true },
  profile_table: { readOnlyHint: true },
  export_table: { readOnlyHint: true },
  record_rehearsal: { readOnlyHint: false, destructiveHint: false },
  apply_migration: { readOnlyHint: false, destructiveHint: true },
  verify_prod_state: { readOnlyHint: true },
};

describe("Streamable HTTP transport + bearer auth", () => {
  let pool: Pool;
  let http: ReturnType<typeof createHttpServer>;
  let url: string;

  before(async () => {
    pool = createPool(await freshDb(DB));
    await seedMiniProd(pool);
    http = createHttpServer({ pool, masker: createMasker("k"), log: () => {} }, TOKEN);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });
  after(async () => {
    await new Promise((r) => http.close(r));
    await pool.end();
    await dropDb(DB);
  });

  const connect = async (token: string) => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };

  test("SDK client lists exactly the 6 tools with the contract annotations and calls read tools", async () => {
    const client = await connect(TOKEN);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(EXPECTED_ANNOTATIONS).sort());
      for (const t of tools) assert.deepEqual(t.annotations, EXPECTED_ANNOTATIONS[t.name], t.name);
      const d: any = await client.callTool({ name: "describe_schema", arguments: {} });
      assert.ok(!d.isError);
      assert.ok(JSON.parse(d.content[0].text).tables.some((t: any) => t.name === "users" && t.create_sql.startsWith("CREATE TABLE")));
      const v: any = await client.callTool({ name: "verify_prod_state", arguments: {} });
      assert.equal(JSON.parse(v.content[0].text).last_applied_version, "0006");
    } finally {
      await client.close();
    }
  });

  test("no token / wrong token -> 401", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body })).status, 401);
    await assert.rejects(connect("nope"), /401|UNAUTHORIZED/i);
  });
});
