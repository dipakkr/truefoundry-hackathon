import { createHash, randomBytes } from "node:crypto";
import { type Client, type Pool, withReadOnly } from "./db.js";
import { schemaFingerprint } from "./schema.js";

/** Audit state lives in schema `pgwarden`, outside `public`, so it never shows up in effects or verify_prod_state. */
const DDL = `
CREATE SCHEMA IF NOT EXISTS pgwarden;
CREATE TABLE IF NOT EXISTS pgwarden.rehearsals (
  id              text PRIMARY KEY,
  sql_sha256      text NOT NULL,
  verdict         text NOT NULL CHECK (verdict IN ('pass','fail')),
  report          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  applied_at      timestamptz,
  applied_version text,
  prod_fingerprint text
);
CREATE TABLE IF NOT EXISTS pgwarden.audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  tool         text NOT NULL,
  outcome      text NOT NULL,
  rehearsal_id text,
  detail       jsonb
);
-- Upgrade path for DBs created before drift detection. Guarded by a catalog check because
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS takes an ACCESS EXCLUSIVE lock even when the column
-- exists, which would queue every record/apply behind an in-flight apply's row lock.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                 WHERE attrelid = 'pgwarden.rehearsals'::regclass AND attname = 'prod_fingerprint' AND NOT attisdropped) THEN
    ALTER TABLE pgwarden.rehearsals ADD COLUMN IF NOT EXISTS prod_fingerprint text;
  END IF;
END $$;`;

/** Idempotent; run before every audit write because `npm run reset` may drop the schema under a running server. */
export async function ensureAuditSchema(pool: Pool): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.query(DDL);
      return;
    } catch (e: any) {
      // Concurrent CREATE ... IF NOT EXISTS can still race on the catalog; retry once.
      if (attempt === 0 && ["23505", "42P07", "42P06"].includes(e.code)) continue;
      throw e;
    }
  }
}

/**
 * The hash everyone uses: sha256 (lowercase hex) over the UTF-8 bytes of `sql.trim()`.
 * Only leading/trailing whitespace is removed; nothing else is normalized.
 */
export function sqlSha256(sql: string): string {
  return createHash("sha256").update(sql.trim(), "utf8").digest("hex");
}

function newRehearsalId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return "rh_" + Array.from(randomBytes(6), (b) => alphabet[b % 36]).join("");
}

/**
 * Stores the rehearsal plus prod's schema fingerprint *as the server sees it now* (computed here,
 * never taken from the caller). apply_migration refuses with DRIFT_DETECTED if prod's schema has
 * changed since (Atlas-style drift detection).
 */
export async function recordRehearsal(pool: Pool, sql: string, verdict: "pass" | "fail", report: unknown) {
  await ensureAuditSchema(pool);
  const sha = sqlSha256(sql);
  const fp = await withReadOnly(pool, schemaFingerprint);
  for (;;) {
    const id = newRehearsalId();
    const r = await pool.query(
      `INSERT INTO pgwarden.rehearsals (id, sql_sha256, verdict, report, prod_fingerprint) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING RETURNING created_at`,
      [id, sha, verdict, JSON.stringify(report ?? null), fp],
    );
    if (r.rowCount) {
      await auditLog(pool, "record_rehearsal", verdict, id, { sql_sha256: sha, prod_fingerprint: fp });
      return { rehearsal_id: id, sql_sha256: sha, recorded_at: new Date(r.rows[0].created_at).toISOString(), prod_fingerprint: fp };
    }
  }
}

export async function auditLog(db: Pool | Client, tool: string, outcome: string, rehearsalId: string | null, detail: unknown) {
  await db.query(`INSERT INTO pgwarden.audit_log (tool, outcome, rehearsal_id, detail) VALUES ($1, $2, $3, $4)`, [
    tool,
    outcome,
    rehearsalId,
    JSON.stringify(detail ?? null),
  ]);
}
