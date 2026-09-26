// npm run pgwarden:project -- <name>: start the pgwarden for one onboarded project, on its own port,
// against its own prod database (URL read from the .env variable the project names), with its masking rules.
import { spawn } from 'node:child_process';
import { env, REPO_ROOT } from './lib/common.js';
import { loadProject } from './lib/projects.js';

const name = process.argv[2];
if (!name) { console.error('usage: npm run pgwarden:project -- <project>'); process.exit(2); }
const p = loadProject(name);
const url = env(p.database_url_env);
if (!url) { console.error(`✗ ${p.database_url_env} is not set in .env`); process.exit(2); }
console.log(`[${p.name}] pgwarden on :${p.pgwarden.port} (MCP server "${p.pgwarden.mcp_name}")`);
const child = spawn('npm', ['--prefix', 'pgwarden', 'run', 'start'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url, PGWARDEN_PORT: String(p.pgwarden.port), PGWARDEN_MASK: p.mask },
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
