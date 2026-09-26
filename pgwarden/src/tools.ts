import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { analyzeMigration } from "./analyze.js";
import { applyMigration } from "./apply.js";
import { recordRehearsal } from "./audit.js";
import { exportTable, MAX_PAGE_SIZE, profileTable } from "./data.js";
import { type Pool, withReadOnly } from "./db.js";
import type { Masker } from "./mask.js";
import { describeSchema, ToolError, verifyProdState } from "./schema.js";

export interface Deps {
  pool: Pool;
  masker: Masker;
  log?: (line: string) => void;
}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (code: string, message: string, detail?: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify(detail === undefined ? { code, message } : { code, message, detail }) }],
});

const declaredEffects = z.object({
  row_deltas: z.record(z.string(), z.number().int()),
  schema_changes: z.array(z.string()),
});

export function buildServer(deps: Deps): McpServer {
  const log = deps.log ?? ((l: string) => console.log(l));
  const server = new McpServer({ name: "pgwarden", version: "0.1.0" });

  // Wraps a handler: JSON result, ToolError -> isError payload, one log line per call (no args, no secrets).
  const run = (tool: string, fn: () => Promise<{ data: unknown; outcome?: string }>) => async (): Promise<CallToolResult> => {
    const t0 = Date.now();
    let outcome = "ok";
    try {
      const r = await fn();
      outcome = r.outcome ?? "ok";
      return ok(r.data);
    } catch (e) {
      if (e instanceof ToolError) {
        outcome = e.code;
        return fail(e.code, e.message, e.detail);
      }
      const err = e as any;
      outcome = "SQL_ERROR";
      return fail("SQL_ERROR", `Postgres error: ${err?.message ?? String(e)}`, err?.code ? { pg_code: err.code } : undefined);
    } finally {
      log(`[pgwarden] tool=${tool} ms=${Date.now() - t0} outcome=${outcome}`);
    }
  };

  server.registerTool(
    "describe_schema",
    {
      title: "Describe prod schema",
      description:
        "Read-only. Schema of prod's public tables in FK order: columns, indexes, constraints, FKs, plus create_sql " +
        "(runnable CREATE TABLE) and index_sql (non-constraint indexes). Build the sandbox copy by running every " +
        "create_sql in array order, then every index_sql. Never hand-write the DDL.",
      inputSchema: { tables: z.array(z.string()).optional().describe("Limit to these tables (default: all public tables)") },
      annotations: { readOnlyHint: true },
    },
    (args) => run("describe_schema", async () => ({ data: await withReadOnly(deps.pool, (c) => describeSchema(c, args.tables)) }))(),
  );

  server.registerTool(
    "profile_table",
    {
      title: "Profile a prod table",
      description: "Read-only. Exact row count and, per column, null_count and distinct_count (plain DISTINCT).",
      inputSchema: { table: z.string(), columns: z.array(z.string()).optional() },
      annotations: { readOnlyHint: true },
    },
    (args) => run("profile_table", async () => ({ data: await withReadOnly(deps.pool, (c) => profileTable(c, args.table, args.columns)) }))(),
  );

  server.registerTool(
    "export_table",
    {
      title: "Export a masked prod table page",
      description:
        `Read-only. One page of a full table, ordered by primary key, PII masked (users.email local part, full_name, phone) ` +
        `with a deterministic case-preserving cipher that keeps exact and lower() equality. page is 0-based; ` +
        `page_size default and max ${MAX_PAGE_SIZE}. Keep paging while has_more is true.`,
      inputSchema: {
        table: z.string(),
        page: z.number().int().min(0).optional(),
        page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run("export_table", async () => ({
        data: await withReadOnly(deps.pool, (c) => exportTable(c, deps.masker, args.table, args.page ?? 0, args.page_size ?? MAX_PAGE_SIZE)),
      }))(),
  );

  server.registerTool(
    "record_rehearsal",
    {
      title: "Record a rehearsal result",
      description:
        "Stores the rehearsal verdict and report for the exact SQL that was rehearsed (hash = sha256 hex of sql.trim(); nothing else is normalized). " +
        "Returns the rehearsal_id that apply_migration requires. Audit record only.",
      inputSchema: {
        sql: z.string().min(1),
        verdict: z.enum(["pass", "fail"]),
        report: z.record(z.string(), z.unknown()).describe("RehearsalReport JSON (CONTRACTS §8)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) =>
      run("record_rehearsal", async () => {
        const data = await recordRehearsal(deps.pool, args.sql, args.verdict, args.report);
        return { data, outcome: `recorded:${args.verdict}` };
      })(),
  );

  server.registerTool(
    "apply_migration",
    {
      title: "Apply a rehearsed migration to PROD",
      description:
        "The only way to change prod. Requires a passing rehearsal of the identical SQL (compared after trim()) (< 30 min old) and the " +
        "declared effects from that rehearsal. Refuses DROP TABLE/SCHEMA/DATABASE, TRUNCATE, DROP COLUMN, RENAME, " +
        "DELETE without WHERE, GRANT/REVOKE, role changes, transaction control, SET, DO blocks, > 20 statements. " +
        "Runs in one transaction and COMMITs only if actual effects equal declared_effects exactly; otherwise rolls back.",
      inputSchema: {
        sql: z.string().min(1),
        rehearsal_id: z.string(),
        declared_effects: declaredEffects,
        evidence_summary: z.string().max(600),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    (args) =>
      run("apply_migration", async () => {
        const data = await applyMigration(deps.pool, args);
        return { data, outcome: `committed:${data.applied_version}` };
      })(),
  );

  server.registerTool(
    "analyze_migration",
    {
      title: "Analyze a migration's risk against prod",
      description:
        "Read-only. Static + data-aware risk report for a migration (Atlas/Squawk-style codes): e.g. MF101 unique index on " +
        "duplicated data (counts duplicate groups on prod), MF103/MF104 NOT NULL on populated/NULL data, BC101/BC102 renames, " +
        "DS101-103 drops, PG101 non-concurrent index, PG301/PG302/PG305/PG306 locking rewrites/scans, DML101 UPDATE/DELETE " +
        "without WHERE, POLICY = what apply_migration would refuse. Never executes the SQL. Not a substitute for a rehearsal.",
      inputSchema: { sql: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    (args) => run("analyze_migration", async () => ({ data: await withReadOnly(deps.pool, (c) => analyzeMigration(c, args.sql)) }))(),
  );

  server.registerTool(
    "verify_prod_state",
    {
      title: "Verify prod state",
      description: "Read-only. Row counts, schema fingerprint, users columns, whether users_email_lower_uniq exists, last applied migration version.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run("verify_prod_state", async () => ({ data: await withReadOnly(deps.pool, verifyProdState) }))(),
  );

  return server;
}
