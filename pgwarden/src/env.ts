import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// Repo-root .env, resolved relative to this file (not the cwd).
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export interface Env {
  databaseUrl: string;
  port: number;
  token: string;
  maskKey: string;
}

export function loadEnv(): Env {
  const missing = ["DATABASE_URL", "PGWARDEN_TOKEN", "PGWARDEN_MASK_KEY"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`pgwarden: missing env vars: ${missing.join(", ")}`);
  return {
    databaseUrl: process.env.DATABASE_URL!,
    port: Number(process.env.PGWARDEN_PORT ?? 8787),
    token: process.env.PGWARDEN_TOKEN!,
    maskKey: process.env.PGWARDEN_MASK_KEY!,
  };
}
