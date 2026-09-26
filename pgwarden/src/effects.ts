import type { Client } from "./db.js";
import { qi } from "./db.js";

/** Facts format shared with skills/migration-rehearsal/scripts/effects.py and fixtures/effects-golden.json. */
export interface TableFacts {
  row_count: number;
  columns: Record<string, { type: string; nullable: boolean }>;
  indexes: string[];
  constraints: string[];
}
export interface Facts {
  tables: Record<string, TableFacts>;
}
export interface Effects {
  row_deltas: Record<string, number>;
  schema_changes: string[];
}

export const EXCLUDED_TABLES = new Set(["schema_migrations"]);

/** Tables of schema public (ordinary + partitioned), minus excluded ones. */
export async function listPublicTables(c: Client): Promise<string[]> {
  const r = await c.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1`,
  );
  return r.rows.map((x) => x.relname);
}

/** Snapshot facts for schema public. Types via format_type(); NOT NULL constraints (PG18 contype 'n') excluded. */
export async function snapshotFacts(c: Client, opts: { rowCounts?: boolean } = {}): Promise<Facts> {
  const withCounts = opts.rowCounts ?? true;
  const tables: Record<string, TableFacts> = {};
  const names = (await listPublicTables(c)).filter((t) => !EXCLUDED_TABLES.has(t));
  for (const t of names) tables[t] = { row_count: 0, columns: {}, indexes: [], constraints: [] };
  if (!names.length) return { tables };

  const cols = await c.query<{ t: string; c: string; ty: string; nullable: boolean }>(
    `SELECT cl.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS ty, NOT a.attnotnull AS nullable
     FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = 'public' AND cl.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY cl.relname, a.attnum`,
    [names],
  );
  for (const r of cols.rows) tables[r.t].columns[r.c] = { type: r.ty, nullable: r.nullable };

  const idx = await c.query<{ t: string; name: string }>(
    `SELECT tablename AS t, indexname AS name FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY 1, 2`,
    [names],
  );
  for (const r of idx.rows) tables[r.t].indexes.push(r.name);

  const con = await c.query<{ t: string; name: string }>(
    `SELECT cl.relname AS t, co.conname AS name
     FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = 'public' AND cl.relname = ANY($1) AND co.contype <> 'n' ORDER BY 1, 2`,
    [names],
  );
  for (const r of con.rows) tables[r.t].constraints.push(r.name);

  if (withCounts) {
    for (const t of names) {
      const r = await c.query<{ n: number }>(`SELECT count(*)::bigint AS n FROM public.${qi(t)}`);
      tables[t].row_count = Number(r.rows[0].n);
    }
  }
  return { tables };
}

const b = (v: boolean) => (v ? "true" : "false");
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0); // code-point order

export function diffFacts(before: Facts, after: Facts): Effects {
  const bt = Object.fromEntries(Object.entries(before.tables).filter(([k]) => !EXCLUDED_TABLES.has(k)));
  const at = Object.fromEntries(Object.entries(after.tables).filter(([k]) => !EXCLUDED_TABLES.has(k)));
  const names = [...new Set([...Object.keys(bt), ...Object.keys(at)])].sort(cmp);
  const row_deltas: Record<string, number> = {};
  const ch: string[] = [];
  for (const t of names) {
    row_deltas[t] = (at[t]?.row_count ?? 0) - (bt[t]?.row_count ?? 0);
    if (!bt[t]) { ch.push(`+table:${t}`); continue; }
    if (!at[t]) { ch.push(`-table:${t}`); continue; }
    const bc = bt[t].columns, ac = at[t].columns;
    for (const c of Object.keys(ac)) if (!(c in bc)) ch.push(`+column:${t}.${c}`);
    for (const c of Object.keys(bc)) {
      if (!(c in ac)) { ch.push(`-column:${t}.${c}`); continue; }
      if (bc[c].type !== ac[c].type) ch.push(`~column:${t}.${c}:${bc[c].type}->${ac[c].type}`);
      if (!!bc[c].nullable !== !!ac[c].nullable) ch.push(`~nullable:${t}.${c}:${b(bc[c].nullable)}->${b(ac[c].nullable)}`);
    }
    for (const [kind, key] of [["index", "indexes"], ["constraint", "constraints"]] as const) {
      const bs = new Set(bt[t][key] ?? []), as = new Set(at[t][key] ?? []);
      for (const n of as) if (!bs.has(n)) ch.push(`+${kind}:${t}.${n}`);
      for (const n of bs) if (!as.has(n)) ch.push(`-${kind}:${t}.${n}`);
    }
  }
  return { row_deltas, schema_changes: [...new Set(ch)].sort(cmp) };
}

/**
 * CONTRACTS §7 comparison: row_deltas exact per key, schema_changes as a set.
 * A table missing from `declared.row_deltas` is read as a declared delta of 0.
 */
export function effectsMatch(declared: Effects, actual: Effects): boolean {
  const keys = new Set([...Object.keys(declared.row_deltas), ...Object.keys(actual.row_deltas)]);
  for (const k of keys) if ((declared.row_deltas[k] ?? 0) !== (actual.row_deltas[k] ?? 0)) return false;
  const d = new Set(declared.schema_changes), a = new Set(actual.schema_changes);
  return d.size === a.size && [...d].every((x) => a.has(x));
}
