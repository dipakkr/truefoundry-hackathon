// Shared helpers for the wiring scripts (setup, doctor, reset, e2e, demo-pr).
// Secrets are only ever reported as present/absent, never printed.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENV_FILE = resolve(REPO_ROOT, '.env');

dotenv.config({ path: ENV_FILE, quiet: true });

/** Trimmed env value, or undefined if unset/empty. */
export function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

/** Values copied verbatim from .env.example that the user has not replaced. */
const PLACEHOLDER_PATTERNS = [/change-me/i, /your-github-user/i, /user:pass@host/i, /YOUR_[A-Z_]+/];
export function isPlaceholder(v: string | undefined): boolean {
  return v !== undefined && PLACEHOLDER_PATTERNS.some((re) => re.test(v));
}

export const TRUEFORGE_BASE_URL = (env('TRUEFORGE_BASE_URL') ?? 'http://localhost:8790').replace(/\/+$/, '');
export const PGWARDEN_PORT = Number(env('PGWARDEN_PORT') ?? '8787');
export const PGWARDEN_URL = `http://localhost:${PGWARDEN_PORT}/mcp`;

export const AGENT_MAIN = 'migration-rehearsal';
export const AGENT_NAIVE = 'migration-rehearsal-naive';
export const PGWARDEN_TOOLS = [
  'describe_schema',
  'profile_table',
  'export_table',
  'record_rehearsal',
  'apply_migration',
  'verify_prod_state',
];

/** The command that starts TrueForge so it may call pgwarden on localhost. */
export const TRUEFORGE_START_CMD = `npm run trueforge   # = OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@0.2.1`;

// ---------- terminal output ----------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = c(32);
export const red = c(31);
export const yellow = c(33);
export const dim = c(2);
export const bold = c(1);

export type Status = 'ok' | 'warn' | 'fail' | 'skip';
export const MARK: Record<Status, string> = {
  ok: green('✓'),
  warn: yellow('!'),
  fail: red('✗'),
  skip: dim('–'),
};

export interface Row {
  step: string;
  status: Status;
  detail: string;
  fix?: string;
}

export function printTable(title: string, rows: Row[]): void {
  const w = Math.max(...rows.map((r) => r.step.length), 4);
  console.log(`\n${bold(title)}`);
  for (const r of rows) {
    console.log(`  ${MARK[r.status]}  ${r.step.padEnd(w)}  ${r.detail}`);
  }
  const fixes = rows.filter((r) => r.fix && (r.status === 'fail' || r.status === 'warn'));
  if (fixes.length) {
    console.log(`\n${bold('Next steps')}`);
    fixes.forEach((r, i) => console.log(`  ${i + 1}. [${r.step}] ${r.fix}`));
  }
}

/** Render a plain table (for e2e summaries). */
export function printGrid(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i] - stripAnsi(cell).length))).join('  ');
  console.log(line(headers.map(bold)));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  rows.forEach((r) => console.log(line(r)));
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : '';
    return causeMsg && !e.message.includes(causeMsg) ? `${e.message} (${causeMsg})` : e.message;
  }
  return String(e);
}

// ---------- child processes ----------
export function runInherit(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<number> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? REPO_ROOT, stdio: 'inherit', env: process.env });
    child.on('error', () => res(127));
    child.on('exit', (code) => res(code ?? 1));
  });
}

export function runCapture(cmd: string, args: string[], opts: { cwd?: string } = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? REPO_ROOT, encoding: 'utf8', env: process.env });
  if (r.error) return { code: 127, stdout: '', stderr: r.error.message };
  return { code: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

/**
 * GitHub token for the `github` MCP server (catalog entry = header auth with a PAT).
 * Order: GITHUB_TOKEN, GH_TOKEN, then `gh auth token`. The value is never printed.
 */
export function githubToken(): { token?: string; source: string } {
  if (env('GITHUB_TOKEN') && !isPlaceholder(env('GITHUB_TOKEN'))) return { token: env('GITHUB_TOKEN'), source: 'GITHUB_TOKEN' };
  if (env('GH_TOKEN')) return { token: env('GH_TOKEN'), source: 'GH_TOKEN' };
  const r = runCapture('gh', ['auth', 'token']);
  if (r.code === 0 && r.stdout) return { token: r.stdout, source: '`gh auth token`' };
  return { source: 'none' };
}

export function fileExists(rel: string): boolean {
  return existsSync(resolve(REPO_ROOT, rel));
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}
