// Read-only prod facts straight from DATABASE_URL (CONTRACTS §3). Never writes.
import pg from 'pg';
import { env, errMsg } from './common.js';

export interface ProdFacts {
  users: number | null; // null = table missing
  orders: number | null;
  dupGroups: number | null; // lower(email) groups with >1 row
  usersColumns: string[];
  hasMobile: boolean;
  hasPhone: boolean;
  hasLowerEmailIndex: boolean;
  lastAppliedVersion: string | null;
}

export const SEEDED: Pick<ProdFacts, 'users' | 'orders' | 'dupGroups' | 'hasMobile' | 'hasPhone' | 'hasLowerEmailIndex'> = {
  users: 5014,
  orders: 20000,
  dupGroups: 14,
  hasMobile: false,
  hasPhone: true,
  hasLowerEmailIndex: false,
};

export const AFTER_CORRECT_FIX = { users: 5000, orders: 20000, dupGroups: 0, hasMobile: true, hasPhone: true, hasLowerEmailIndex: true };

export async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 20_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  return r.rows[0].ok === true;
}

async function countOrNull(c: pg.Client, table: string): Promise<number | null> {
  if (!(await tableExists(c, table))) return null;
  const r = await c.query(`SELECT count(*)::int AS n FROM public.${table}`);
  return r.rows[0].n as number;
}

export async function prodFacts(): Promise<ProdFacts> {
  return withClient(async (c) => {
    const users = await countOrNull(c, 'users');
    const orders = await countOrNull(c, 'orders');
    let dupGroups: number | null = null;
    let usersColumns: string[] = [];
    if (users !== null) {
      const d = await c.query(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM public.users GROUP BY lower(email) HAVING count(*) > 1) g`,
      );
      dupGroups = d.rows[0].n;
      const cols = await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position`,
      );
      usersColumns = cols.rows.map((r) => r.column_name as string);
    }
    const idx = await c.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='users' AND indexname='users_email_lower_uniq'`,
    );
    let lastAppliedVersion: string | null = null;
    if (await tableExists(c, 'schema_migrations')) {
      const v = await c.query(`SELECT max(version) AS v FROM public.schema_migrations`);
      lastAppliedVersion = v.rows[0].v ?? null;
    }
    return {
      users,
      orders,
      dupGroups,
      usersColumns,
      hasMobile: usersColumns.includes('mobile'),
      hasPhone: usersColumns.includes('phone'),
      hasLowerEmailIndex: (idx.rowCount ?? 0) > 0,
      lastAppliedVersion,
    };
  });
}

/** Compare facts against an expectation; returns a list of human-readable mismatches. */
export function diffFacts(actual: ProdFacts, expected: Partial<ProdFacts>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    const a = (actual as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(a) !== JSON.stringify(v)) out.push(`${k}=${JSON.stringify(a)} (want ${JSON.stringify(v)})`);
  }
  return out;
}

export function factsLine(f: ProdFacts): string {
  return [
    `users=${f.users ?? 'MISSING'}`,
    `orders=${f.orders ?? 'MISSING'}`,
    `dup_groups=${f.dupGroups ?? '?'}`,
    `mobile=${f.hasMobile ? 'yes' : 'no'}`,
    `phone=${f.hasPhone ? 'yes' : 'no'}`,
    `idx_lower_email=${f.hasLowerEmailIndex ? 'yes' : 'no'}`,
    `last_version=${f.lastAppliedVersion ?? '-'}`,
  ].join('  ');
}

export async function dbReachable(): Promise<{ ok: boolean; detail: string }> {
  try {
    const v = await withClient(async (c) => (await c.query('SHOW server_version')).rows[0].server_version as string);
    return { ok: true, detail: `Postgres ${v}` };
  } catch (e) {
    return { ok: false, detail: errMsg(e) };
  }
}
