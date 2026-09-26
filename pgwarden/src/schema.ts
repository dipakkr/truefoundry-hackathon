import { createHash } from "node:crypto";
import type { Client } from "./db.js";
import { qi } from "./db.js";
import { type Facts, listPublicTables, snapshotFacts } from "./effects.js";

export interface ColumnInfo { name: string; type: string; nullable: boolean; default: string | null }
export interface IndexInfo { name: string; definition: string; unique: boolean }
export interface ConstraintInfo { name: string; type: string; definition: string }
export interface ForeignKeyInfo { name: string; column: string; ref_table: string; ref_column: string }
export interface TableInfo {
  name: string;
  row_estimate: number;
  create_sql: string;
  index_sql: string[];
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
  foreign_keys: ForeignKeyInfo[];
}
export interface SchemaDescription { pg_version: string; tables: TableInfo[] }

const CONTYPE: Record<string, string> = { p: "PRIMARY KEY", u: "UNIQUE", f: "FOREIGN KEY", c: "CHECK", x: "EXCLUDE" };
const CON_ORDER = "pcuxf"; // order of table constraints inside create_sql
const SERIAL: Record<string, string> = { bigint: "bigserial", integer: "serial", smallint: "smallserial" };

export async function getPgVersion(c: Client): Promise<string> {
  return (await c.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0].v;
}

/** Validates a user-supplied table name against the live catalog (public schema). */
export async function assertTable(c: Client, table: string): Promise<void> {
  const tables = await listPublicTables(c);
  if (!tables.includes(table)) throw new ToolError("UNKNOWN_TABLE", `table "${table}" does not exist in schema public`, { tables });
}

export class ToolError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

/**
 * describe_schema. Tables come back in FK dependency order (referenced tables first), so running
 * every create_sql in array order, then every index_sql, rebuilds the schema on an empty database.
 */
export async function describeSchema(c: Client, only?: string[]): Promise<SchemaDescription> {
  const all = await listPublicTables(c);
  if (only?.length) for (const t of only) if (!all.includes(t)) throw new ToolError("UNKNOWN_TABLE", `table "${t}" does not exist in schema public`, { tables: all });
  const names = only?.length ? all.filter((t) => only.includes(t)) : all;

  const cols = await c.query(
    `SELECT cl.relname AS t, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default,
            a.attidentity AS identity, a.attgenerated AS generated,
            pg_get_serial_sequence(format('%I.%I', n.nspname, cl.relname), a.attname) AS owned_seq
     FROM pg_attribute a
     JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND cl.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY cl.relname, a.attnum`,
    [names],
  );
  const idx = await c.query(
    `SELECT t.relname AS t, i.relname AS name, pg_get_indexdef(i.oid) AS definition, x.indisunique AS unique,
            EXISTS (SELECT 1 FROM pg_constraint co WHERE co.conindid = i.oid AND co.contype IN ('p','u','x')) AS backs_constraint
     FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = ANY($1) ORDER BY t.relname, i.relname`,
    [names],
  );
  const con = await c.query(
    `SELECT cl.relname AS t, co.conname AS name, co.contype AS type, pg_get_constraintdef(co.oid) AS definition,
            rt.relname AS ref_table,
            (SELECT string_agg(a.attname, ', ' ORDER BY k.ord) FROM unnest(co.conkey) WITH ORDINALITY k(n, ord)
               JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.n) AS cols,
            (SELECT string_agg(a.attname, ', ' ORDER BY k.ord) FROM unnest(co.confkey) WITH ORDINALITY k(n, ord)
               JOIN pg_attribute a ON a.attrelid = co.confrelid AND a.attnum = k.n) AS ref_cols
     FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
     LEFT JOIN pg_class rt ON rt.oid = co.confrelid
     WHERE n.nspname = 'public' AND cl.relname = ANY($1) AND co.contype IN ('p','u','f','c','x')
     ORDER BY cl.relname, co.conname`,
    [names],
  );
  const counts: Record<string, number> = {};
  for (const t of names) counts[t] = Number((await c.query(`SELECT count(*)::bigint AS n FROM public.${qi(t)}`)).rows[0].n);

  const tables: TableInfo[] = names.map((t) => {
    const tc = cols.rows.filter((r) => r.t === t);
    const ti = idx.rows.filter((r) => r.t === t);
    const tk = con.rows.filter((r) => r.t === t);

    const preamble: string[] = [];
    const colLines = tc.map((r) => {
      // bigserial & co: the sequence is owned by the column and follows the <table>_<col>_seq naming,
      // so `bigserial` recreates the identical default (nextval('<t>_<c>_seq'::regclass)) on an empty DB.
      const isSerial = SERIAL[r.type] && r.owned_seq === `public.${t}_${r.name}_seq` &&
        r.default === `nextval('${t}_${r.name}_seq'::regclass)`;
      if (isSerial) return `  ${qi(r.name)} ${SERIAL[r.type]}${r.nullable ? "" : " NOT NULL"}`;
      // Any other nextval() default needs its sequence to exist first.
      const seq = /^nextval\('([^']+)'::regclass\)$/.exec(r.default ?? "")?.[1];
      if (seq) preamble.push(`CREATE SEQUENCE IF NOT EXISTS ${seq};\n`);
      let line = `  ${qi(r.name)} ${r.type}`;
      if (r.identity) line += ` GENERATED ${r.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
      else if (r.generated === "s") line += ` GENERATED ALWAYS AS (${r.default}) STORED`;
      else if (r.default != null) line += ` DEFAULT ${r.default}`;
      if (!r.nullable) line += " NOT NULL";
      return line;
    });
    const conLines = [...tk]
      .sort((a, b) => CON_ORDER.indexOf(a.type) - CON_ORDER.indexOf(b.type) || (a.name < b.name ? -1 : 1))
      .map((r) => `  CONSTRAINT ${qi(r.name)} ${r.definition}`);

    return {
      name: t,
      row_estimate: counts[t],
      create_sql: `${preamble.join("")}CREATE TABLE ${qi(t)} (\n${[...colLines, ...conLines].join(",\n")}\n);`,
      index_sql: ti.filter((r) => !r.backs_constraint).map((r) => r.definition), // = pg_indexes.indexdef
      columns: tc.map((r) => ({ name: r.name, type: r.type, nullable: r.nullable, default: r.default })),
      indexes: ti.map((r) => ({ name: r.name, definition: r.definition, unique: r.unique })),
      constraints: tk.map((r) => ({ name: r.name, type: CONTYPE[r.type], definition: r.definition })),
      foreign_keys: tk
        .filter((r) => r.type === "f")
        .map((r) => ({ name: r.name, column: r.cols, ref_table: r.ref_table, ref_column: r.ref_cols })),
    };
  });

  return { pg_version: await getPgVersion(c), tables: fkOrder(tables) };
}

/** Topological sort: a table comes after every table it references (self-references ignored). */
function fkOrder(tables: TableInfo[]): TableInfo[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const out: TableInfo[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: TableInfo) => {
    if (state.get(t.name)) return; // done, or a cycle (emit in encounter order)
    state.set(t.name, "visiting");
    for (const fk of t.foreign_keys) {
      const dep = byName.get(fk.ref_table);
      if (dep && dep !== t) visit(dep);
    }
    state.set(t.name, "done");
    out.push(t);
  };
  for (const t of tables) visit(t);
  return out;
}

/**
 * Schema fingerprint = sha256 over schema facts only (no row counts), canonical key order.
 * Used by verify_prod_state, record_rehearsal (stored) and apply_migration (drift check).
 */
export function fingerprintOf(facts: Facts): string {
  const schemaOnly = Object.fromEntries(
    Object.keys(facts.tables).sort().map((t) => {
      const f = facts.tables[t];
      const columns = Object.keys(f.columns).sort().map((col) => [col, f.columns[col].type, f.columns[col].nullable]);
      return [t, { columns, indexes: [...f.indexes].sort(), constraints: [...f.constraints].sort() }];
    }),
  );
  return createHash("sha256").update(JSON.stringify(schemaOnly)).digest("hex");
}

/** Prod's current schema fingerprint (catalog only, no row counts). */
export async function schemaFingerprint(c: Client): Promise<string> {
  return fingerprintOf(await snapshotFacts(c, { rowCounts: false }));
}

/** verify_prod_state */
export async function verifyProdState(c: Client) {
  const facts = await snapshotFacts(c);
  const row_counts = Object.fromEntries(Object.entries(facts.tables).map(([t, f]) => [t, f.row_count]));
  const schema_fingerprint = fingerprintOf(facts);
  const users = facts.tables.users;
  let last_applied_version: string | null = null;
  if ((await listPublicTables(c)).includes("schema_migrations")) {
    last_applied_version = (await c.query("SELECT max(version) AS v FROM public.schema_migrations")).rows[0].v;
  }
  return {
    row_counts,
    schema_fingerprint,
    has_index_users_email_lower_uniq: !!users?.indexes.includes("users_email_lower_uniq"),
    columns_users: users ? Object.keys(users.columns) : [],
    last_applied_version,
  };
}
