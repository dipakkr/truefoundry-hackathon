// Onboarded projects: one JSON file per app repo in projects/. Each project gets its own pgwarden
// (own database, masking rules, audit log and MCP server name) and its own TrueForge agent.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './common.js';

export interface Project {
  name: string;
  repo: string; // owner/name on GitHub
  migrations_path: string;
  queries_path: string;
  database_url_env: string; // name of the .env variable holding this project's prod URL (never the URL itself)
  mask: string; // PGWARDEN_MASK spec: table.column:email|text,...
  protected_tables?: string[]; // append-only: pgwarden refuses any apply that removes their rows
  pgwarden: { port: number; mcp_name: string };
  agent: string;
  runner_label: string;
}

const DIR = resolve(REPO_ROOT, 'projects');
export const projectPath = (name: string) => resolve(DIR, `${name}.json`);

export function loadProject(name: string): Project {
  const p = projectPath(name);
  if (!existsSync(p)) throw new Error(`unknown project "${name}" (no projects/${name}.json; run npm run onboard)`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function listProjects(): Project[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(resolve(DIR, f), 'utf8')));
}

export function saveProject(p: Project): void {
  writeFileSync(projectPath(p.name), `${JSON.stringify(p, null, 2)}\n`);
}

/** Defaults for a new project: next free pgwarden port, per-project MCP server and agent names. */
export function newProject(name: string, repo: string, opts: Partial<Project> = {}): Project {
  const ports = listProjects().map((p) => p.pgwarden.port);
  return {
    name,
    repo,
    migrations_path: opts.migrations_path ?? 'migrations',
    queries_path: opts.queries_path ?? 'src/queries',
    database_url_env: opts.database_url_env ?? `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_DATABASE_URL`,
    mask: opts.mask ?? '',
    pgwarden: { port: Math.max(8787, ...ports) + 1, mcp_name: `pgwarden-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
    agent: `migration-rehearsal-${name}`,
    runner_label: 'migration-rehearsal',
  };
}
