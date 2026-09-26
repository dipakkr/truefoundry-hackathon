import { loadModule, parseSync } from "libpg-query";

export const MAX_STATEMENTS = 20;

export interface PolicyResult {
  ok: boolean;
  statements: number;
  violations: string[];
}

let loaded: Promise<void> | null = null;
export function ensureParser(): Promise<void> {
  return (loaded ??= loadModule());
}

type Node = Record<string, any>;

/** Depth-first walk over every AST node, yielding [nodeType, body] pairs (e.g. ["DeleteStmt", {...}]). */
function* walk(v: unknown): Generator<[string, Node]> {
  if (Array.isArray(v)) {
    for (const x of v) yield* walk(x);
  } else if (v && typeof v === "object") {
    for (const [k, body] of Object.entries(v as Node)) {
      if (/^[A-Z]/.test(k) && body && typeof body === "object" && !Array.isArray(body)) yield [k, body];
      yield* walk(body);
    }
  }
}

const rel = (n: Node) => n?.relation?.relname ?? "?";

/**
 * CONTRACTS §5 step 1. Parses with the real Postgres parser (libpg_query) and walks the whole
 * tree, so statements hidden in CTEs are seen too. Fails closed: unparseable SQL is refused.
 * Beyond the contract list, it also refuses things that would break the single guarded
 * transaction or hide SQL from this check: BEGIN/COMMIT/ROLLBACK/SAVEPOINT, SET/RESET, and DO blocks.
 */
export async function checkPolicy(sql: string): Promise<PolicyResult> {
  await ensureParser();
  let stmts: unknown[];
  try {
    stmts = parseSync(sql).stmts ?? [];
  } catch (e) {
    return { ok: false, statements: 0, violations: [`SQL does not parse: ${(e as Error).message}`] };
  }
  const v: string[] = [];
  if (stmts.length === 0) v.push("no SQL statements");
  if (stmts.length > MAX_STATEMENTS) v.push(`${stmts.length} statements (max ${MAX_STATEMENTS})`);

  for (const [type, n] of walk(stmts)) {
    switch (type) {
      case "DropStmt":
        if (n.removeType === "OBJECT_TABLE") v.push("DROP TABLE");
        if (n.removeType === "OBJECT_SCHEMA") v.push("DROP SCHEMA");
        break;
      case "DropdbStmt":
        v.push("DROP DATABASE");
        break;
      case "TruncateStmt":
        v.push("TRUNCATE");
        break;
      case "AlterTableCmd":
        if (n.subtype === "AT_DropColumn") v.push(`ALTER TABLE … DROP COLUMN ${n.name ?? ""}`.trim());
        break;
      case "RenameStmt":
        // Renames break running app code; use expand/contract instead.
        if (n.renameType === "OBJECT_COLUMN") v.push(`RENAME COLUMN ${rel(n)}.${n.subname} (use expand/contract: add the new column, keep the old one)`);
        else v.push(`RENAME TO (${String(n.renameType).replace("OBJECT_", "").toLowerCase()} ${rel(n)} -> ${n.newname})`);
        break;
      case "DeleteStmt":
        if (!n.whereClause) v.push(`DELETE without WHERE on ${rel(n)}`);
        break;
      case "GrantStmt":
      case "GrantRoleStmt":
        v.push(n.is_grant ? "GRANT" : "REVOKE"); // protobuf JSON omits false
        break;
      case "AlterRoleStmt":
      case "AlterRoleSetStmt":
      case "CreateRoleStmt":
      case "DropRoleStmt":
        v.push("role management (ALTER/CREATE/DROP ROLE)");
        break;
      case "TransactionStmt":
        v.push(`transaction control (${n.kind}); pgwarden wraps the migration in its own transaction`);
        break;
      case "VariableSetStmt":
        v.push("SET/RESET; pgwarden sets lock_timeout and statement_timeout itself");
        break;
      case "DoStmt":
        v.push("DO block (its body cannot be policy-checked)");
        break;
    }
  }
  return { ok: v.length === 0, statements: stmts.length, violations: [...new Set(v)] };
}
