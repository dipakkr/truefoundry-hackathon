import { createHash, randomBytes } from "node:crypto";
import type { Client, Pool } from "./db.js";

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
  applied_version text
);
CREATE TABLE IF NOT EXISTS pgwarden.audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  tool         text NOT NULL,
  outcome      text NOT NULL,
  rehearsal_id text,
  detail       jsonb
);`;

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

export async function recordRehearsal(pool: Pool, sql: string, verdict: "pass" | "fail", report: unknown) {
  await ensureAuditSchema(pool);
  const sha = sqlSha256(sql);
  for (;;) {
    const id = newRehearsalId();
    const r = await pool.query(
      `INSERT INTO pgwarden.rehearsals (id, sql_sha256, verdict, report) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING RETURNING created_at`,
      [id, sha, verdict, JSON.stringify(report ?? null)],
    );
    if (r.rowCount) {
      await auditLog(pool, "record_rehearsal", verdict, id, { sql_sha256: sha });
      return { rehearsal_id: id, sql_sha256: sha, recorded_at: new Date(r.rows[0].created_at).toISOString() };
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
