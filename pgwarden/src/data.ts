import type { Client } from "./db.js";
import { qi } from "./db.js";
import { MASKED_COLUMNS, type Masker } from "./mask.js";
import { assertTable, ToolError } from "./schema.js";

async function tableColumns(c: Client, table: string): Promise<{ name: string; type: string }[]> {
  const r = await c.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_attribute a WHERE a.attrelid = format('public.%I', $1::text)::regclass
       AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [table],
  );
  return r.rows;
}

/** profile_table: exact counts, plain DISTINCT (deliberately no lower(): the rehearsal must find L1). */
export async function profileTable(c: Client, table: string, columns?: string[]) {
  await assertTable(c, table);
  const all = await tableColumns(c, table);
  const names = all.map((x) => x.name);
  const unknown = (columns ?? []).filter((x) => !names.includes(x));
  if (unknown.length) throw new ToolError("UNKNOWN_COLUMN", `unknown column(s) on ${table}: ${unknown.join(", ")}`, { columns: names });
  const picked = columns?.length ? all.filter((x) => columns.includes(x.name)) : all;

  const noEquality = /^(json|xml|point|polygon|line|box|path|circle)\b/;
  const selects = picked.flatMap((col, i) => {
    const expr = noEquality.test(col.type) ? `${qi(col.name)}::text` : qi(col.name);
    return [`count(*) - count(${qi(col.name)}) AS n${i}`, `count(DISTINCT ${expr}) AS d${i}`];
  });
  const r = await c.query(`SELECT count(*)::bigint AS total${selects.length ? ", " + selects.join(", ") : ""} FROM public.${qi(table)}`);
  const row = r.rows[0];
  return {
    table,
    row_count: Number(row.total),
    columns: picked.map((col, i) => ({ name: col.name, null_count: Number(row[`n${i}`]), distinct_count: Number(row[`d${i}`]) })),
  };
}

export const MAX_PAGE_SIZE = 5000;

/** export_table: full table, paged, ordered by PK, masked per CONTRACTS §4. */
export async function exportTable(c: Client, masker: Masker, table: string, page = 0, pageSize = MAX_PAGE_SIZE) {
  await assertTable(c, table);
  if (!Number.isInteger(page) || page < 0) throw new ToolError("BAD_ARGUMENT", "page must be an integer >= 0");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
    throw new ToolError("BAD_ARGUMENT", `page_size must be an integer in 1..${MAX_PAGE_SIZE}`);

  const columns = (await tableColumns(c, table)).map((x) => x.name);
  const pk = await c.query<{ name: string }>(
    `SELECT a.attname AS name FROM pg_index x
     JOIN unnest(x.indkey) WITH ORDINALITY k(n, ord) ON true
     JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.n
     WHERE x.indrelid = format('public.%I', $1::text)::regclass AND x.indisprimary ORDER BY k.ord`,
    [table],
  );
  const orderBy = (pk.rows.length ? pk.rows.map((r) => r.name) : columns).map(qi).join(", ");
  const total = Number((await c.query(`SELECT count(*)::bigint AS n FROM public.${qi(table)}`)).rows[0].n);
  const r = await c.query({
    text: `SELECT ${columns.map(qi).join(", ")} FROM public.${qi(table)} ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
    values: [pageSize, page * pageSize],
    rowMode: "array",
  });

  const rules = MASKED_COLUMNS[table] ?? {};
  const maskers = columns.map((col) =>
    rules[col] === "email" ? masker.maskEmail : rules[col] === "text" ? masker.mask : null,
  );
  const rows = (r.rows as unknown[][]).map((row) =>
    row.map((v, i) => (maskers[i] && typeof v === "string" ? maskers[i]!(v) : v)),
  );
  return { table, page, page_size: pageSize, total_rows: total, has_more: (page + 1) * pageSize < total, columns, rows };
}
