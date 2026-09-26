import pg from "pg";

// Return int8 as a JS number when it is exactly representable (ids, counts), else as a string.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});
// Dates/timestamps as Postgres text: exact (keeps microseconds) and round-trippable on insert.
for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, (v) => v);

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on("error", (err) => console.error(`[pgwarden] idle client error: ${err.message}`));
  return pool;
}

/** Runs fn inside `BEGIN READ ONLY`; always rolls back (nothing to keep). */
export async function withReadOnly<T>(pool: pg.Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/** Double-quote an identifier (only used on names that were already validated against the catalog). */
export function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
