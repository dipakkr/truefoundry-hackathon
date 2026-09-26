import { createHash } from "node:crypto";
import { type Client, type Pool, qi } from "./db.js";
import { auditLog, ensureAuditSchema, sqlSha256 } from "./audit.js";
import { diffFacts, effectsMatch, snapshotFacts, type Effects, type Facts } from "./effects.js";
import { checkPolicy } from "./policy.js";
import { fingerprintOf, ToolError } from "./schema.js";

export const REHEARSAL_MAX_AGE_MIN = 30;
/** pg advisory lock key held (transaction-scoped) for the whole apply: one apply at a time per database. */
export const APPLY_LOCK_KEY = 7_070_707_001; // arbitrary constant ("pgwarden apply")
/** Tables with more rows than this are not copied by the pre-apply backup (use PITR / branching at scale). */
export const BACKUP_MAX_ROWS = 1_000_000;

export interface ApplyArgs {
  sql: string;
  rehearsal_id: string;
  declared_effects: Effects;
  evidence_summary: string;
}

/**
 * CONTRACTS §5 apply algorithm:
 * policy pre-check -> rehearsal lookup -> one transaction with timeouts -> run SQL ->
 * actual effects == declared ? record version + COMMIT : ROLLBACK.
 * Throws ToolError with a §6 code on every refusal.
 */
export interface ApplyOptions {
  /** Override BACKUP_MAX_ROWS (tests). */
  backupMaxRows?: number;
}

export async function applyMigration(pool: Pool, args: ApplyArgs, opts: ApplyOptions = {}) {
  const t0 = Date.now();
  const sql = args.sql.trim(); // what is hashed is exactly what is checked and executed
  const sha = sqlSha256(sql);

  // 1. Policy pre-check, before any DB work. Refused even if a human approved the call.
  const policy = await checkPolicy(sql);
  if (!policy.ok) {
    await refusalAudit(pool, "POLICY_REFUSED", args.rehearsal_id, { sql_sha256: sha, violations: policy.violations });
    throw new ToolError(
      "POLICY_REFUSED",
      `Refused by pgwarden policy (a human approval cannot override this): ${policy.violations.join("; ")}.`,
      { violations: policy.violations, statements: policy.statements },
    );
  }

  await ensureAuditSchema(pool);
  const client = await pool.connect();
  let open = false;
  const refuse = async (code: string, message: string, detail?: unknown): Promise<never> => {
    if (open) await client.query("ROLLBACK");
    open = false;
    await refusalAudit(pool, code, args.rehearsal_id, { sql_sha256: sha, ...(detail as object) });
    throw new ToolError(code, message, detail);
  };

  try {
    await client.query("BEGIN");
    open = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    // 1b. Deploy queue: one apply at a time. Taken before the rehearsal lookup, so a second apply
    // that gets the lock after the first COMMITs sees its result (READ COMMITTED) -> ALREADY_APPLIED.
    const locked = (await client.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS ok", [APPLY_LOCK_KEY])).rows[0].ok;
    if (!locked) await refuse("APPLY_IN_PROGRESS", "Another migration is being applied to prod right now; try again when it has finished.");

    // 2. Rehearsal lookup. Row lock serializes concurrent applies of the same rehearsal.
    const rh = (
      await client.query(
        `SELECT id, verdict, sql_sha256, applied_at, created_at, prod_fingerprint,
                created_at < now() - make_interval(mins => $2) AS stale,
                EXISTS (SELECT 1 FROM pgwarden.rehearsals o WHERE o.sql_sha256 = r.sql_sha256 AND o.applied_at IS NOT NULL) AS sql_applied
         FROM pgwarden.rehearsals r WHERE id = $1 FOR UPDATE`,
        [args.rehearsal_id, REHEARSAL_MAX_AGE_MIN],
      )
    ).rows[0];
    if (!rh) await refuse("REHEARSAL_NOT_FOUND", `No rehearsal with id "${args.rehearsal_id}". Rehearse first and call record_rehearsal.`);
    if (rh.verdict !== "pass")
      await refuse("REHEARSAL_FAILED", `Rehearsal ${rh.id} has verdict "${rh.verdict}"; only a passing rehearsal can be applied.`);
    if (rh.sql_sha256 !== sha)
      await refuse("REHEARSAL_MISMATCH", `The SQL differs from what rehearsal ${rh.id} tested (sha256 mismatch). Apply the exact rehearsed SQL, or rehearse this SQL.`, {
        rehearsed_sha256: rh.sql_sha256,
        submitted_sha256: sha,
      });
    if (rh.stale)
      await refuse("REHEARSAL_STALE", `Rehearsal ${rh.id} is older than ${REHEARSAL_MAX_AGE_MIN} minutes; prod may have changed. Rehearse again.`, {
        recorded_at: new Date(rh.created_at).toISOString(),
      });
    if (rh.applied_at || rh.sql_applied)
      await refuse("ALREADY_APPLIED", `This migration was already applied${rh.applied_at ? ` (rehearsal ${rh.id} at ${new Date(rh.applied_at).toISOString()})` : ""}.`);

    // 3. Snapshot (inside the transaction, after the lock).
    const before = await snapshotFacts(client);

    // 3a. Drift detection: prod's schema must be the one the rehearsal was recorded against.
    // Rehearsals recorded before this check existed have no fingerprint and skip it.
    const current_fingerprint = fingerprintOf(before);
    if (rh.prod_fingerprint && rh.prod_fingerprint !== current_fingerprint)
      await refuse(
        "DRIFT_DETECTED",
        `Prod's schema changed since rehearsal ${rh.id} was recorded, so the rehearsal no longer proves anything about prod. Rehearse again against the current schema.`,
        { rehearsed_fingerprint: rh.prod_fingerprint, current_fingerprint },
      );

    // 3b. Pre-apply backup into schema pgwarden. Inside the transaction: a refused / rolled-back
    // apply leaves no backup, a committed one keeps it.
    const version = await nextVersion(client);
    const backup = await backupTables(client, before, version, opts.backupMaxRows ?? BACKUP_MAX_ROWS);

    // 3c. Run, snapshot, diff.
    try {
      await client.query(sql);
    } catch (e: any) {
      await refuse("SQL_ERROR", `Postgres error: ${e.message}. Rolled back; prod is unchanged.`, {
        message: e.message,
        pg_code: e.code,
        detail: e.detail,
        hint: e.hint,
        position: e.position,
      });
    }
    const actual = diffFacts(before, await snapshotFacts(client));

    // 4. Declared must equal actual (row deltas exact, schema changes as a set).
    if (!effectsMatch(args.declared_effects, actual))
      await refuse("EFFECTS_MISMATCH", "The migration's actual effects differ from the declared effects. Rolled back; prod is unchanged.", {
        declared: args.declared_effects,
        actual,
      });

    // 5. Record the version (computed before the backup), mark the rehearsal applied, COMMIT.
    await client.query("INSERT INTO public.schema_migrations (version) VALUES ($1)", [version]);
    await client.query("UPDATE pgwarden.rehearsals SET applied_at = now(), applied_version = $2 WHERE id = $1", [rh.id, version]);
    const duration_ms = Date.now() - t0;
    await auditLog(client, "apply_migration", "committed", rh.id, {
      sql_sha256: sha,
      applied_version: version,
      actual_effects: actual,
      evidence_summary: args.evidence_summary,
      backup,
      duration_ms,
    });
    await client.query("COMMIT");
    open = false;
    return { status: "committed" as const, applied_version: version, actual_effects: actual, duration_ms, backup };
  } catch (e) {
    // 6. Anything unexpected (lock timeout during snapshot, etc.): roll back and report as SQL_ERROR.
    if (open) await client.query("ROLLBACK").catch(() => {});
    if (e instanceof ToolError) throw e;
    const err = e as any;
    await refusalAudit(pool, "SQL_ERROR", args.rehearsal_id, { sql_sha256: sha, message: err.message });
    throw new ToolError("SQL_ERROR", `Postgres error: ${err.message}. Rolled back; prod is unchanged.`, { message: err.message, pg_code: err.code });
  } finally {
    client.release();
  }
}

/** Next zero-padded numeric version after the highest one in schema_migrations ('0006' -> '0007'). */
async function nextVersion(client: import("./db.js").Client): Promise<string> {
  const r = await client.query(`SELECT max(version) AS v FROM public.schema_migrations WHERE version ~ '^[0-9]+$'`);
  const cur: string | null = r.rows[0].v;
  if (!cur) return "0001";
  return String(Number(cur) + 1).padStart(cur.length, "0");
}

export interface BackupResult {
  schema: "pgwarden";
  tables: { table: string; backup_table: string; rows: number }[];
  skipped: { table: string; rows: number; reason: string }[];
  duration_ms: number;
}

/**
 * Copies every public table (schema_migrations excluded, as in the effects snapshot) with at most
 * maxRows rows into pgwarden.bk_<version>_<table>. Row counts come from the exact counts of the
 * `before` snapshot. Names longer than Postgres's 63-byte limit get a hash suffix instead of being
 * silently truncated; an existing name (e.g. left over after schema_migrations was hand-edited) gets
 * a numeric suffix rather than failing the apply.
 */
async function backupTables(client: Client, before: Facts, version: string, maxRows: number): Promise<BackupResult> {
  const t0 = Date.now();
  const tables: BackupResult["tables"] = [];
  const skipped: BackupResult["skipped"] = [];
  for (const [table, f] of Object.entries(before.tables).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (f.row_count > maxRows) {
      skipped.push({ table, rows: f.row_count, reason: `more than ${maxRows} rows; use point-in-time recovery / a branch at this size` });
      continue;
    }
    const name = await freeBackupName(client, `bk_${version}_${table}`);
    await client.query(`CREATE TABLE pgwarden.${qi(name)} AS TABLE public.${qi(table)}`);
    tables.push({ table, backup_table: `pgwarden.${name}`, rows: f.row_count });
  }
  return { schema: "pgwarden", tables, skipped, duration_ms: Date.now() - t0 };
}

async function freeBackupName(client: Client, base: string): Promise<string> {
  const fit = (s: string) =>
    Buffer.byteLength(s, "utf8") <= 63 ? s : `${Buffer.from(s, "utf8").subarray(0, 50).toString("utf8").replace(/\uFFFD+$/, "")}_${createHash("sha256").update(s).digest("hex").slice(0, 8)}`;
  for (let n = 1; ; n++) {
    const name = fit(n === 1 ? base : `${base}_${n}`);
    const r = await client.query("SELECT to_regclass(format('pgwarden.%I', $1::text)) IS NULL AS free", [name]);
    if (r.rows[0].free) return name;
  }
}

async function refusalAudit(pool: Pool, code: string, rehearsalId: string | null, detail: unknown) {
  try {
    await ensureAuditSchema(pool);
    await auditLog(pool, "apply_migration", code, rehearsalId, detail);
  } catch (e) {
    console.error(`[pgwarden] audit write failed: ${(e as Error).message}`);
  }
}
