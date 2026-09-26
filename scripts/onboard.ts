// npm run onboard -- --project <name> [--repo owner/name] [--db-env VAR] [--migrations dir] [--queries dir] [--no-pr]
//
// Connects an app repo and its prod database to Migration Rehearsal:
//   1. project config in projects/<name>.json (new projects get the next free pgwarden port)
//   2. prod database checks: reachable, schema_migrations with numeric versions
//   3. PII scan: suggests masking rules from column names and sampled values
//   4. registers the project's pgwarden as its own MCP server in TrueForge
//   5. registers the project's agent (same skill, approval gate on apply_migration enforced)
//   6. opens a PR on the app repo adding .github/workflows/migration-rehearsal.yml
//   7. checks for an online self-hosted runner with the project's label
// Idempotent: safe to re-run. Never prints secret values.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { env, errMsg, isPlaceholder, parseArgs, printTable, REPO_ROOT, runCapture, AGENT_MAIN, type Row } from './lib/common.js';
import { listAgents, loadAgentFile, tf } from './lib/trueforge.js';
import { listProjects, loadProject, newProject, saveProject, type Project } from './lib/projects.js';

const args = parseArgs(process.argv.slice(2));
const name = typeof args.project === 'string' ? args.project : undefined;
if (!name) {
  console.error('usage: npm run onboard -- --project <name> --repo <owner/name> [--db-env VAR] [--migrations dir] [--queries dir] [--no-pr]');
  process.exit(2);
}
const rows: Row[] = [];
const add = (r: Row) => { rows.push(r); console.log(`${r.status === 'ok' ? '✓' : r.status === 'warn' ? '!' : '✗'} ${r.step}: ${r.detail}`); };
const finish: () => never = () => { printTable(`npm run onboard -- --project ${name}`, rows); process.exit(rows.some((r) => r.status === 'fail') ? 1 : 0); };

// ---------- 1. project config ----------
let project: Project;
if (listProjects().some((p) => p.name === name)) {
  project = loadProject(name);
  add({ step: 'project', status: 'ok', detail: `projects/${name}.json (${project.repo})` });
} else {
  const repo = typeof args.repo === 'string' ? args.repo : undefined;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    add({ step: 'project', status: 'fail', detail: 'new project needs --repo owner/name' });
    finish();
  }
  project = newProject(name, repo!, {
    database_url_env: typeof args['db-env'] === 'string' ? args['db-env'] : undefined,
    migrations_path: typeof args.migrations === 'string' ? args.migrations : undefined,
    queries_path: typeof args.queries === 'string' ? args.queries : undefined,
  });
  add({ step: 'project', status: 'ok', detail: `new: ${repo}, pgwarden :${project.pgwarden.port} as "${project.pgwarden.mcp_name}", agent ${project.agent}` });
}

// ---------- 2. prod database ----------
const dbUrl = env(project.database_url_env);
if (!dbUrl) {
  add({ step: 'prod database', status: 'fail', detail: `${project.database_url_env} is not set in .env`, fix: `Add ${project.database_url_env}=postgres://... to .env (read-only role is enough for rehearsals).` });
  finish();
}
const client = new pg.Client({ connectionString: dbUrl });
let suggested = '';
try {
  await client.connect();
  const tables = (await client.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
  const hasMig = tables.includes('schema_migrations');
  const last = hasMig ? (await client.query(`SELECT max(version) AS v FROM schema_migrations WHERE version ~ '^[0-9]+$'`)).rows[0].v : null;
  add(hasMig && last
    ? { step: 'prod database', status: 'ok', detail: `${tables.length - 1} tables, schema_migrations at ${last}` }
    : { step: 'prod database', status: 'fail', detail: `${tables.length} tables; ${hasMig ? 'no numeric versions' : 'no schema_migrations table'}`, fix: 'pgwarden records applied versions in public.schema_migrations(version text).' });

  // ---------- 3. PII scan ----------
  const NAME_HINTS: Array<[RegExp, 'email' | 'text']> = [
    [/(^|_)(email|e_mail|upi|upi_id|vpa)$/i, 'email'],
    [/(^|_)(phone|mobile|msisdn|full_name|first_name|last_name|name|pan|aadhaar|ssn|address|dob|date_of_birth|card_number|account_number|ifsc)$/i, 'text'],
  ];
  const VALUE_HINTS: Array<[RegExp, 'email' | 'text', string]> = [
    [/^[\w.+-]+@[\w-]+(\.[\w.-]+)?$/, 'email', 'email / UPI id'],
    [/^\+?\d[\d\s-]{8,}$/, 'text', 'phone number'],
    [/^[A-Z]{5}\d{4}[A-Z]$/, 'text', 'PAN'],
  ];
  const found: Array<{ col: string; kind: 'email' | 'text'; why: string }> = [];
  for (const t of tables.filter((x) => x !== 'schema_migrations')) {
    const cols = (await client.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND data_type IN ('text', 'character varying') ORDER BY ordinal_position`, [t])).rows.map((r) => r.c);
    for (const c of cols) {
      const byName = NAME_HINTS.find(([re]) => re.test(c));
      const sample = (await client.query(`SELECT ${pg.escapeIdentifier(c)} AS v FROM ${pg.escapeIdentifier(t)} WHERE ${pg.escapeIdentifier(c)} IS NOT NULL LIMIT 200`)).rows.map((r) => String(r.v));
      const byValue = VALUE_HINTS.find(([re]) => sample.length && sample.filter((v) => re.test(v)).length / sample.length > 0.8);
      if (byName || byValue) {
        const kind = byValue ? byValue[1] : byName![1];
        found.push({ col: `${t}.${c}`, kind, why: [byName && 'column name', byValue && `values look like ${byValue[2]}`].filter(Boolean).join(' + ') });
      }
    }
  }
  suggested = found.map((f) => `${f.col}:${f.kind}`).join(',');
  for (const f of found) console.log(`    PII  ${f.col.padEnd(28)} → ${f.kind.padEnd(5)}  (${f.why})`);
  if (!project.mask) project.mask = suggested;
  add({ step: 'masking', status: project.mask ? 'ok' : 'warn', detail: project.mask ? `${project.mask.split(',').length} columns masked in every export (${project.mask === suggested ? 'suggested' : 'from config'})` : 'no PII columns detected', fix: project.mask ? undefined : 'Set "mask" in the project file if the scan missed any.' });
} catch (e) {
  add({ step: 'prod database', status: 'fail', detail: errMsg(e) });
  finish();
} finally {
  await client.end().catch(() => {});
}
saveProject(project);

// ---------- 4. pgwarden MCP server for this project ----------
const token = env('PGWARDEN_TOKEN');
if (!token || isPlaceholder(token)) {
  add({ step: 'mcp', status: 'fail', detail: 'PGWARDEN_TOKEN missing in .env' });
  finish();
}
const url = `http://localhost:${project.pgwarden.port}/mcp`;
const put = await tf('PUT', '/settings/mcp-servers', {
  manifest: {
    type: 'remote',
    name: project.pgwarden.mcp_name,
    url,
    description: `Migration Rehearsal gatekeeper for ${project.repo} prod: schema/profile/masked export (read-only), rehearsal records, and the human-gated apply_migration.`,
    auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } },
  },
});
if (!put.ok) {
  add({ step: 'mcp', status: 'fail', detail: put.error ?? 'PUT failed' });
  finish();
}
const tools = await tf<{ data: Array<{ name: string }> }>('GET', `/mcp-servers/${project.pgwarden.mcp_name}/tools`, undefined, 15_000);
add(tools.ok
  ? { step: 'mcp', status: 'ok', detail: `"${project.pgwarden.mcp_name}" → ${url}; ${tools.body.data.length} tools` }
  : { step: 'mcp', status: 'warn', detail: `"${project.pgwarden.mcp_name}" registered; pgwarden not reachable yet`, fix: `Start it: npm run pgwarden:project -- ${project.name}` });

// ---------- 5. agent ----------
const agents = await listAgents();
const main = agents.ok ? agents.body.find((a) => a.name === AGENT_MAIN) : undefined;
const fqn = main?.manifest?.model?.name;
if (!fqn) {
  add({ step: 'agent', status: 'fail', detail: `${AGENT_MAIN} is not registered, so there is no model to copy`, fix: 'Run npm run setup first.' });
  finish();
}
const loaded = loadAgentFile('agent/migration-rehearsal.agent.json', project.agent, { MODEL_FQN: fqn });
if (!loaded.ok) {
  add({ step: 'agent', status: 'fail', detail: loaded.error });
  finish();
}
const m = loaded.agent.manifest;
const server = project.pgwarden.mcp_name;
for (const s of m.mcp_servers) if (s.name === 'pgwarden') s.name = server;
const gate = m.mcp_servers.find((s: any) => s.name === server);
if (!gate?.require_approval_for_tools?.includes('apply_migration')) {
  // Fail closed: an agent without the human gate on apply_migration must never be registered.
  add({ step: 'agent', status: 'fail', detail: 'approval gate on apply_migration missing from the generated spec; refusing to register' });
  finish();
}
if (server !== 'pgwarden') m.instructions = m.instructions.replace(/\bpgwarden\b/g, server);
m.instructions =
  `Project: ${project.repo}. Prod database is behind the MCP server \`${server}\`: call every pgwarden tool through it ` +
  `and pass server="${server}" to sources.export_tables. Migrations live in \`${project.migrations_path}/\`, app queries in ` +
  `\`${project.queries_path}/\` (use that path wherever the skill says src/queries).\n\n${m.instructions}`;
const prior = agents.ok ? agents.body.find((a) => a.name === project.agent) : undefined;
const description = `Migration Rehearsal for ${project.repo}: rehearses migration PRs on a masked copy of prod, applies only through the human-gated ${server}.apply_migration.`;
const r = prior
  ? await tf('PUT', `/agents/${prior.id}`, { description, manifest: m })
  : await tf('POST', '/agents', { name: project.agent, description, manifest: m });
add(r.ok
  ? { step: 'agent', status: 'ok', detail: `${prior ? 'updated' : 'created'} ${project.agent} (gate: apply_migration needs approval)` }
  : { step: 'agent', status: 'fail', detail: r.error ?? 'failed' });

// ---------- 6. CI workflow PR on the app repo ----------
const WF = '.github/workflows/migration-rehearsal.yml';
const gh = (a: string[]) => runCapture('gh', a);
const existing = gh(['api', `repos/${project.repo}/contents/${WF}`, '--jq', '.sha']);
if (existing.code === 0) {
  add({ step: 'ci workflow', status: 'ok', detail: `${WF} already on ${project.repo}` });
} else if (args['no-pr']) {
  add({ step: 'ci workflow', status: 'warn', detail: 'skipped (--no-pr)' });
} else {
  const yml = readFileSync(resolve(REPO_ROOT, 'ci/workflow.template.yml'), 'utf8')
    .replaceAll('{{PROJECT}}', project.name).replaceAll('{{AGENT}}', project.agent)
    .replaceAll('{{MIGRATIONS_PATH}}', project.migrations_path).replaceAll('{{RUNNER_LABEL}}', project.runner_label);
  const branch = 'add-migration-rehearsal';
  const base = gh(['api', `repos/${project.repo}`, '--jq', '.default_branch']).stdout || 'main';
  const sha = gh(['api', `repos/${project.repo}/git/ref/heads/${base}`, '--jq', '.object.sha']).stdout;
  gh(['api', '-X', 'POST', `repos/${project.repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`]);
  const put2 = gh(['api', '-X', 'PUT', `repos/${project.repo}/contents/${WF}`, '-f', `message=Add Migration Rehearsal: rehearse migration PRs on a masked copy of prod`, '-f', `branch=${branch}`, '-f', `content=${Buffer.from(yml).toString('base64')}`]);
  const body = [
    '## Summary',
    `Connects this repo to Migration Rehearsal. Every PR that changes \`${project.migrations_path}/\` is rehearsed on a masked copy of prod by the \`${project.agent}\` agent in TrueForge before it can reach production.`,
    '',
    '## What this adds',
    `- \`${WF}\`: on PRs touching \`${project.migrations_path}/**\` (or by hand with \`workflow_dispatch\`), a job on the self-hosted \`${project.runner_label}\` runner starts a rehearsal and mirrors its progress as the **Migration Rehearsal / prod data** commit status.`,
    '- Forks never run on the self-hosted runner.',
    '- Applying to prod still needs a human: the approval card is in TrueForge, and pgwarden re-verifies the effects before committing.',
    '',
    '## Setup already done by onboarding',
    `- pgwarden for this project on :${project.pgwarden.port} (MCP server \`${server}\`), masking ${project.mask.split(',').length} PII columns`,
    `- agent \`${project.agent}\` registered in TrueForge`,
  ].join('\n');
  const pr = put2.code === 0
    ? gh(['pr', 'create', '-R', project.repo, '--base', base, '--head', branch, '--title', 'Add Migration Rehearsal to CI', '--body', body])
    : put2;
  add(pr.code === 0
    ? { step: 'ci workflow', status: 'ok', detail: `PR opened: ${pr.stdout.trim()}` }
    : { step: 'ci workflow', status: 'fail', detail: (pr.stderr || pr.stdout).slice(0, 200) });
}

// ---------- 7. runner ----------
const runners = gh(['api', `repos/${project.repo}/actions/runners`, '--jq', `[.runners[] | select(.status == "online") | select([.labels[].name] | index("${project.runner_label}"))] | length`]);
add(Number(runners.stdout) > 0
  ? { step: 'runner', status: 'ok', detail: `${runners.stdout} online self-hosted runner(s) labelled ${project.runner_label}` }
  : { step: 'runner', status: 'warn', detail: `no online runner with label ${project.runner_label} on ${project.repo}`, fix: `Register one next to TrueForge: ./config.sh --url https://github.com/${project.repo} --labels ${project.runner_label} (token: gh api -X POST repos/${project.repo}/actions/runners/registration-token)` });

console.log(`\nStart this project's pgwarden:  npm run pgwarden:project -- ${project.name}`);
finish();
