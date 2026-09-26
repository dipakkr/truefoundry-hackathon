import { parseSync } from "libpg-query";
import { type Client, qi } from "./db.js";
import { listPublicTables } from "./effects.js";
import { ensureParser, MAX_STATEMENTS, type Node, policyViolations, walk } from "./policy.js";

/**
 * analyze_migration: a static + data-aware risk report for a migration (Atlas / Squawk style).
 *
 * Safety: it never executes the submitted SQL. The only SQL it runs is aggregates it builds itself
 * from catalog-validated identifiers (quoted with qi()) over plain columns or lower(col), inside the
 * caller's READ ONLY transaction, with a statement timeout. Evidence carries counts only, never
 * row values (the values would bypass export_table's masking).
 *
 * Checks run against prod as it is *now*. When an earlier statement in the same migration writes the
 * table (UPDATE/DELETE/INSERT/MERGE), a data finding cannot be conclusive, so errors are downgraded
 * to warnings: the rehearsal is what proves the migration.
 */

export type Severity = "error" | "warning" | "info";
export interface Finding {
  code: string;
  severity: Severity;
  statement_index: number | null; // 0-based; null = the whole script
  message: string;
  evidence?: Record<string, unknown>;
}
export interface AnalysisReport {
  statements: number;
  findings: Finding[];
  summary: { errors: number; warnings: number; info: number; verdict: "errors" | "warnings" | "clean"; text: string };
}

const SERIAL_TYPES = new Set(["serial", "serial2", "serial4", "serial8", "smallserial", "bigserial"]);
const fmt = (n: number) => n.toLocaleString("en-US");
const sval = (x: any): string | undefined => x?.String?.sval;

/** A unique-key element we can evaluate safely: a plain column or lower(column). */
interface KeyExpr { column: string; lower: boolean }

function keyFromIndexElem(e: Node): KeyExpr | null {
  if (e.opclass?.length || e.collation?.length) return null; // non-default equality semantics
  if (e.name) return { column: e.name, lower: false };
  const f = e.expr?.FuncCall;
  if (!f) return null;
  const fname = (f.funcname ?? []).map(sval);
  const isLower = (fname.length === 1 && fname[0] === "lower") || (fname.length === 2 && fname[0] === "pg_catalog" && fname[1] === "lower");
  if (!isLower || f.args?.length !== 1 || f.agg_star || f.agg_distinct || f.over || f.agg_filter || f.agg_order) return null;
  const fields = f.args[0]?.ColumnRef?.fields;
  if (fields?.length !== 1 || !sval(fields[0])) return null;
  return { column: sval(fields[0])!, lower: true };
}

const keyLabel = (k: KeyExpr[]) => k.map((x) => (x.lower ? `lower(${x.column})` : x.column)).join(", ");

export async function analyzeMigration(c: Client, sql: string): Promise<AnalysisReport> {
  await ensureParser();
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  let stmts: { stmt?: unknown }[];
  try {
    stmts = parseSync(sql).stmts ?? [];
  } catch (e) {
    add({ code: "POLICY", severity: "error", statement_index: null, message: `SQL does not parse: ${(e as Error).message}. apply_migration would refuse it (POLICY_REFUSED).` });
    return report(0, findings);
  }
  if (stmts.length === 0)
    add({ code: "POLICY", severity: "error", statement_index: null, message: "No SQL statements. apply_migration would refuse it (POLICY_REFUSED)." });
  if (stmts.length > MAX_STATEMENTS)
    add({ code: "POLICY", severity: "error", statement_index: null, message: `${stmts.length} statements (max ${MAX_STATEMENTS}). apply_migration would refuse it (POLICY_REFUSED).` });

  await c.query("SET LOCAL statement_timeout = '20s'");
  const prodTables = new Set(await listPublicTables(c));

  // --- cached catalog / data lookups (identifiers validated against the catalog before use) ---
  const rowCache = new Map<string, number>();
  const rows = async (t: string) => {
    if (!rowCache.has(t)) rowCache.set(t, Number((await c.query(`SELECT count(*)::bigint AS n FROM public.${qi(t)}`)).rows[0].n));
    return rowCache.get(t)!;
  };
  const colCache = new Map<string, Map<string, { nullable: boolean; type: string }>>();
  const columns = async (t: string) => {
    if (!colCache.has(t)) {
      const r = await c.query(
        `SELECT a.attname AS name, NOT a.attnotnull AS nullable, format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a WHERE a.attrelid = format('public.%I', $1::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
        [t],
      );
      colCache.set(t, new Map(r.rows.map((x: any) => [x.name, { nullable: x.nullable, type: x.type }])));
    }
    return colCache.get(t)!;
  };
  /** Runs fn in a savepoint so a failing check (type error, timeout) doesn't abort the analysis. */
  let sp = 0;
  const safe = async <T>(fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; error: string }> => {
    const name = `analyze_${++sp}`;
    await c.query(`SAVEPOINT ${name}`);
    try {
      const v = await fn();
      await c.query(`RELEASE SAVEPOINT ${name}`);
      return { ok: true, v };
    } catch (e) {
      await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return { ok: false, error: (e as Error).message };
    }
  };

  // Tables written (DML) / created by earlier statements of this same migration.
  const writtenBy = new Map<string, number[]>();
  const created = new Set<string>();

  /** Resolves a RangeVar to a prod public table name, or null (other schema / not in prod / created here). */
  const target = (rv: Node | undefined): string | null => {
    const t = rv?.relname;
    if (!t || (rv!.schemaname && rv!.schemaname !== "public")) return null;
    if (created.has(t) || !prodTables.has(t)) return null;
    return t;
  };
  const priorWrites = (t: string) => writtenBy.get(t) ?? [];
  const priorNote = (t: string) =>
    ` But earlier statement(s) in this migration (statement_index ${priorWrites(t).join(", ")}) write to ${t} and may resolve this before it runs; only the rehearsal can prove it.`;

  async function uniqueCheck(i: number, t: string, keys: KeyExpr[] | null, what: string, extra: { partial?: boolean; nullsNotDistinct?: boolean } = {}) {
    const n = await rows(t);
    const cols = await columns(t);
    const unknown = keys?.filter((k) => !cols.has(k.column)).map((k) => k.column) ?? [];
    if (!keys || extra.partial || unknown.length) {
      const why = !keys ? "the key is not a plain column or lower(column)" : extra.partial ? "it is a partial index" : `column(s) ${unknown.join(", ")} do not exist in prod yet`;
      add({ code: "MF101", severity: "warning", statement_index: i, message: `${what} on ${t} (${fmt(n)} rows) could not be data-checked because ${why}. It fails if existing rows are duplicated; the rehearsal must prove it.`, evidence: { table: t, rows: n } });
      return;
    }
    const exprs = keys.map((k) => (k.lower ? `lower(${qi(k.column)})` : qi(k.column)));
    const where = extra.nullsNotDistinct ? "" : `WHERE ${exprs.map((e) => `${e} IS NOT NULL`).join(" AND ")}`;
    const r = await safe(async () =>
      (
        await c.query(
          `SELECT count(*)::bigint AS groups, coalesce(sum(n), 0)::bigint AS dup_rows, coalesce(max(n), 0)::bigint AS max_n
           FROM (SELECT count(*) AS n FROM public.${qi(t)} ${where} GROUP BY ${exprs.join(", ")} HAVING count(*) > 1) d`,
        )
      ).rows[0],
    );
    const key = keyLabel(keys);
    if (!r.ok) {
      add({ code: "MF101", severity: "warning", statement_index: i, message: `${what} on ${t} (${key}): duplicate check failed (${r.error}); the rehearsal must prove it.`, evidence: { table: t, key, rows: n } });
      return;
    }
    const groups = Number(r.v.groups);
    const evidence = { table: t, key, rows: n, duplicate_groups: groups, duplicate_rows: Number(r.v.dup_rows), example_count: Number(r.v.max_n) };
    if (groups === 0) {
      add({ code: "MF101", severity: "info", statement_index: i, message: `${what} on ${t} (${key}): no duplicate values in prod's ${fmt(n)} rows.`, evidence });
    } else {
      const prior = priorWrites(t).length > 0;
      add({
        code: "MF101",
        severity: prior ? "warning" : "error",
        statement_index: i,
        message:
          `${what} on ${t} (${key}): ${groups} group(s) of existing prod rows share the same key ` +
          `(${Number(r.v.dup_rows)} rows; largest group ${Number(r.v.max_n)}), so it fails on prod's current data.` +
          (prior ? priorNote(t) : " Resolve the duplicates in the same migration first."),
        evidence,
      });
    }
  }

  for (let i = 0; i < stmts.length; i++) {
    const node = (stmts[i].stmt ?? {}) as Node;

    // Policy (the exact rules apply_migration enforces), per statement.
    for (const v of new Set(policyViolations(node)))
      add({ code: "POLICY", severity: "error", statement_index: i, message: `pgwarden policy refuses this: ${v}. apply_migration would return POLICY_REFUSED (a human approval cannot override it).` });

    const [type, body] = Object.entries(node)[0] ?? ["", {}];
    const b = body as Node;

    if (type === "IndexStmt") {
      const t = target(b.relation);
      if (b.concurrent)
        add({ code: "PG101", severity: "error", statement_index: i, message: "CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and apply_migration runs the migration in one transaction: it would fail with SQL_ERROR. Build the index CONCURRENTLY as a separate out-of-band step, or drop CONCURRENTLY." });
      if (t) {
        const n = await rows(t);
        if (!b.concurrent)
          add({
            code: "PG101",
            severity: "warning",
            statement_index: i,
            message:
              `CREATE INDEX${b.unique ? " (UNIQUE)" : ""} ${b.idxname ?? ""} without CONCURRENTLY blocks writes to ${t} (${fmt(n)} rows) while it builds. ` +
              `pgwarden applies in a transaction, so CONCURRENTLY is not allowed here; for a large table build it CONCURRENTLY out-of-band first.`,
            evidence: { table: t, rows: n },
          });
        if (b.unique) {
          const keys = (b.indexParams ?? []).map((p: Node) => (p.IndexElem ? keyFromIndexElem(p.IndexElem) : null));
          await uniqueCheck(i, t, keys.includes(null) ? null : keys, `Unique index ${b.idxname ?? ""}`.trim(), { partial: !!b.whereClause, nullsNotDistinct: !!b.nulls_not_distinct });
        }
      }
    }

    if (type === "AlterTableStmt" && b.objtype !== "OBJECT_INDEX") {
      const t = target(b.relation);
      for (const cmdWrap of b.cmds ?? []) {
        const cmd = cmdWrap.AlterTableCmd;
        if (!cmd) continue;
        switch (cmd.subtype) {
          case "AT_AddColumn": {
            const def = cmd.def?.ColumnDef;
            if (!def || !t) break;
            const cons = (def.constraints ?? []).map((x: Node) => x.Constraint).filter(Boolean);
            const has = (k: string) => cons.some((x: Node) => x.contype === k);
            const typeName = sval(def.typeName?.names?.at(-1)) ?? "";
            const serial = SERIAL_TYPES.has(typeName);
            const notNull = has("CONSTR_NOTNULL") || has("CONSTR_PRIMARY");
            const defaultExpr = cons.find((x: Node) => x.contype === "CONSTR_DEFAULT")?.raw_expr;
            const n = await rows(t);
            if (notNull && !defaultExpr && !serial && !has("CONSTR_IDENTITY") && !has("CONSTR_GENERATED")) {
              if (n > 0)
                add({ code: "MF103", severity: "error", statement_index: i, message: `ADD COLUMN ${def.colname} NOT NULL without a DEFAULT fails on ${t}, which has ${fmt(n)} rows. Add it nullable, backfill, then SET NOT NULL (or give it a DEFAULT).`, evidence: { table: t, rows: n } });
              else add({ code: "MF103", severity: "info", statement_index: i, message: `ADD COLUMN ${def.colname} NOT NULL without a DEFAULT: ${t} is empty in prod, so it succeeds now.`, evidence: { table: t, rows: 0 } });
            }
            // Volatile default (incl. serial/identity, which default to nextval()) rewrites every row under ACCESS EXCLUSIVE.
            const funcs = defaultExpr ? [...walk(defaultExpr)].filter(([k]) => k === "FuncCall").map(([, f]) => sval((f.funcname ?? []).at(-1))).filter(Boolean) as string[] : [];
            let volatile: string[] = [];
            if (funcs.length) {
              const r = await c.query(`SELECT DISTINCT proname FROM pg_proc WHERE proname = ANY($1) AND provolatile = 'v' ORDER BY 1`, [funcs]);
              volatile = r.rows.map((x: any) => x.proname);
            }
            if (serial || has("CONSTR_IDENTITY")) volatile.push("nextval");
            if (volatile.length)
              add({ code: "PG302", severity: "warning", statement_index: i, message: `ADD COLUMN ${def.colname} with a volatile default (${volatile.join(", ")}) rewrites all ${fmt(n)} rows of ${t} under an ACCESS EXCLUSIVE lock. Add the column without the default, then backfill in batches.`, evidence: { table: t, rows: n, volatile_functions: volatile } });
            break;
          }
          case "AT_SetNotNull": {
            if (!t) break;
            const col = cmd.name as string;
            const cols = await columns(t);
            const n = await rows(t);
            if (!cols.has(col)) {
              add({ code: "MF104", severity: "warning", statement_index: i, message: `SET NOT NULL on ${t}.${col}: the column does not exist in prod yet, so it could not be data-checked; the rehearsal must prove it.`, evidence: { table: t, column: col } });
              break;
            }
            if (!cols.get(col)!.nullable) {
              add({ code: "MF104", severity: "info", statement_index: i, message: `${t}.${col} is already NOT NULL in prod.`, evidence: { table: t, column: col } });
              break;
            }
            const r = await safe(async () => Number((await c.query(`SELECT count(*)::bigint AS n FROM public.${qi(t)} WHERE ${qi(col)} IS NULL`)).rows[0].n));
            if (!r.ok) {
              add({ code: "MF104", severity: "warning", statement_index: i, message: `SET NOT NULL on ${t}.${col}: NULL count failed (${r.error}).`, evidence: { table: t, column: col } });
              break;
            }
            const evidence = { table: t, column: col, rows: n, null_rows: r.v };
            if (r.v > 0) {
              const prior = priorWrites(t).length > 0;
              add({ code: "MF104", severity: prior ? "warning" : "error", statement_index: i, message: `SET NOT NULL on ${t}.${col} fails on prod's current data: ${fmt(r.v)} of ${fmt(n)} rows are NULL.` + (prior ? priorNote(t) : " Backfill them first."), evidence });
            } else {
              add({ code: "MF104", severity: "info", statement_index: i, message: `SET NOT NULL on ${t}.${col}: no NULLs in prod's ${fmt(n)} rows (it still scans the table under ACCESS EXCLUSIVE; on big tables add a NOT VALID CHECK (col IS NOT NULL) first).`, evidence });
            }
            break;
          }
          case "AT_AlterColumnType": {
            if (!t) break;
            const n = await rows(t);
            add({ code: "PG301", severity: "warning", statement_index: i, message: `ALTER COLUMN ${cmd.name} TYPE on ${t} can rewrite the whole table (${fmt(n)} rows) and its indexes under an ACCESS EXCLUSIVE lock. Prefer expand/contract: add a new column, backfill, switch readers.`, evidence: { table: t, column: cmd.name, rows: n } });
            break;
          }
          case "AT_AddConstraint": {
            const con = cmd.def?.Constraint;
            if (!con || !t) break;
            const n = await rows(t);
            if ((con.contype === "CONSTR_UNIQUE" || con.contype === "CONSTR_PRIMARY") && !con.indexname) {
              const keys: KeyExpr[] = (con.keys ?? []).map((k: any) => ({ column: sval(k)!, lower: false }));
              await uniqueCheck(i, t, keys.length && keys.every((k) => k.column) ? keys : null, `${con.contype === "CONSTR_PRIMARY" ? "PRIMARY KEY" : "UNIQUE"} constraint ${con.conname ?? ""}`.trim(), { nullsNotDistinct: !!con.nulls_not_distinct });
            }
            if (con.contype === "CONSTR_CHECK" && !con.skip_validation)
              add({ code: "PG305", severity: "warning", statement_index: i, message: `ADD CONSTRAINT ${con.conname ?? ""} CHECK without NOT VALID scans all ${fmt(n)} rows of ${t} under an ACCESS EXCLUSIVE lock. Add it NOT VALID, then VALIDATE CONSTRAINT separately.`, evidence: { table: t, rows: n } });
            if (con.contype === "CONSTR_FOREIGN" && !con.skip_validation)
              add({ code: "PG306", severity: "warning", statement_index: i, message: `ADD CONSTRAINT ${con.conname ?? ""} FOREIGN KEY without NOT VALID scans all ${fmt(n)} rows of ${t} and locks both tables. Add it NOT VALID, then VALIDATE CONSTRAINT separately.`, evidence: { table: t, rows: n } });
            break;
          }
          case "AT_DropColumn":
            add({ code: "DS103", severity: "error", statement_index: i, message: `DROP COLUMN ${cmd.name} on ${b.relation?.relname}: irreversible data loss, and running clients that read it break. pgwarden policy refuses it; use expand/contract.`, evidence: t ? { table: t, rows: await rows(t) } : undefined });
            break;
        }
      }
    }

    if (type === "RenameStmt") {
      const rt = b.renameType;
      if (rt === "OBJECT_COLUMN")
        add({ code: "BC102", severity: "error", statement_index: i, message: `RENAME COLUMN ${b.relation?.relname}.${b.subname} -> ${b.newname} breaks every running client that still reads "${b.subname}". pgwarden policy refuses renames; use expand/contract (add ${b.newname}, backfill, keep ${b.subname}).` });
      else if (rt === "OBJECT_TABLE")
        add({ code: "BC101", severity: "error", statement_index: i, message: `RENAME TABLE ${b.relation?.relname} -> ${b.newname} breaks every running client that still uses "${b.relation?.relname}". pgwarden policy refuses renames; use expand/contract (e.g. a view).` });
    }

    if (type === "DropStmt" && (b.removeType === "OBJECT_TABLE" || b.removeType === "OBJECT_SCHEMA")) {
      const schema = b.removeType === "OBJECT_SCHEMA";
      for (const obj of b.objects ?? []) {
        const parts = (obj.List?.items ?? [obj]).map(sval).filter(Boolean) as string[];
        const name = parts.join(".");
        const t = !schema && (parts.length === 1 || parts[0] === "public") ? target({ relname: parts.at(-1), schemaname: parts.length > 1 ? parts[0] : undefined }) : null;
        add({
          code: schema ? "DS101" : "DS102",
          severity: "error",
          statement_index: i,
          message: `DROP ${schema ? "SCHEMA" : "TABLE"} ${name}: irreversible data loss${t ? ` (${fmt(await rows(t))} rows)` : ""}. pgwarden policy refuses it.`,
          evidence: t ? { table: t, rows: await rows(t) } : undefined,
        });
      }
    }

    // DML101: UPDATE / DELETE without WHERE anywhere in the statement (incl. CTEs).
    for (const [k, n] of walk(node)) {
      if ((k === "UpdateStmt" || k === "DeleteStmt") && !n.whereClause) {
        const t = target(n.relation);
        const count = t ? await rows(t) : undefined;
        add({
          code: "DML101",
          severity: "warning",
          statement_index: i,
          message: `${k === "UpdateStmt" ? "UPDATE" : "DELETE"} without WHERE ${k === "UpdateStmt" ? "rewrites" : "deletes"} every row of ${n.relation?.relname}${count !== undefined ? ` (${fmt(count)} rows)` : ""} in one transaction, holding row locks on all of them until COMMIT.`,
          evidence: t ? { table: t, rows: count } : undefined,
        });
      }
    }

    // Book-keeping for later statements.
    for (const [k, n] of walk(node)) {
      if (["UpdateStmt", "DeleteStmt", "InsertStmt", "MergeStmt"].includes(k) && n.relation?.relname) {
        const t = n.relation.relname as string;
        writtenBy.set(t, [...new Set([...(writtenBy.get(t) ?? []), i])]);
      }
      if (k === "CreateStmt" && n.relation?.relname) created.add(n.relation.relname);
    }
  }
  return report(stmts.length, findings);
}

function report(statements: number, findings: Finding[]): AnalysisReport {
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const errors = count("error"), warnings = count("warning"), info = count("info");
  const verdict = errors ? "errors" : warnings ? "warnings" : "clean";
  const codes = (s: Severity) => [...new Set(findings.filter((f) => f.severity === s).map((f) => f.code))].join(", ");
  const text =
    verdict === "errors"
      ? `${errors} error(s) (${codes("error")}): this migration will fail or break prod as written.`
      : verdict === "warnings"
        ? `No errors; ${warnings} warning(s) (${codes("warning")}) to review.`
        : "No errors or warnings.";
  return { statements, findings, summary: { errors, warnings, info, verdict, text } };
}
