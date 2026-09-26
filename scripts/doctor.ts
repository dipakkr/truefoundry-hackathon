// npm run doctor: read-only health check of every moving part, with what to fix next.
// Never writes to TrueForge or the DB, never prints secrets.
import {
  AGENT_MAIN,
  AGENT_NAIVE,
  ENV_FILE,
  PGWARDEN_TOOLS,
  PGWARDEN_URL,
  Row,
  TRUEFORGE_START_CMD,
  env,
  errMsg,
  fileExists,
  githubToken,
  isPlaceholder,
  printTable,
  runCapture,
} from './lib/common.js';
import { SEEDED, dbReachable, diffFacts, factsLine, prodFacts } from './lib/db.js';
import { listAgents, modelMode, tf, trueforgeReachable } from './lib/trueforge.js';
import { existsSync } from 'node:fs';

const rows: Row[] = [];
const add = (r: Row) => rows.push(r);

// ---------- Node ----------
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  const ok = maj > 22 || (maj === 22 && min >= 14);
  add({ step: 'node', status: ok ? 'ok' : 'fail', detail: `v${process.versions.node} (need ≥ 22.14)`, fix: ok ? undefined : 'Install Node 22.14+ (e.g. `nvm install 22`).' });
}

// ---------- .env ----------
{
  if (!existsSync(ENV_FILE)) add({ step: '.env', status: 'fail', detail: 'missing', fix: 'cp .env.example .env and fill it in.' });
  const required = ['DATABASE_URL', 'PGWARDEN_TOKEN', 'PGWARDEN_MASK_KEY', 'SHOPKART_REPO', 'SKILL_REPO_URL', 'SKILL_REF', 'PR_NUMBER'];
  const status = required.map((k) => ({ k, v: env(k) }));
  const missing = status.filter((s) => !s.v).map((s) => s.k);
  const placeholders = status.filter((s) => s.v && isPlaceholder(s.v)).map((s) => s.k);
  add({
    step: '.env required',
    status: missing.length || placeholders.length ? 'fail' : 'ok',
    detail: required.map((k) => `${missing.includes(k) || placeholders.includes(k) ? '✗' : '✓'}${k}`).join(' '),
    fix: missing.length || placeholders.length ? `Fill in ${[...missing, ...placeholders].join(', ')} in .env${placeholders.length ? ' (still .env.example placeholders)' : ''}.` : undefined,
  });
  const mode = modelMode();
  add({
    step: '.env model key',
    status: mode === 'none' ? 'fail' : 'ok',
    detail:
      mode === 'tfy-gateway'
        ? '✓TFY_GATEWAY_BASE_URL ✓TFY_GATEWAY_API_KEY ✓MODEL_ID'
        : mode === 'openai' || mode === 'anthropic'
          ? `✓${mode === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} (TFY_GATEWAY_* not set)`
          : `✗ none (${['TFY_GATEWAY_BASE_URL', 'TFY_GATEWAY_API_KEY', 'MODEL_ID', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].map((k) => `${env(k) ? '✓' : '✗'}${k}`).join(' ')})`,
    fix: mode === 'none' ? 'Set TFY_GATEWAY_BASE_URL + TFY_GATEWAY_API_KEY + MODEL_ID (or just OPENAI_API_KEY / ANTHROPIC_API_KEY).' : undefined,
  });
  add({
    step: '.env DAYTONA_API_KEY',
    status: env('DAYTONA_API_KEY') ? 'ok' : 'warn',
    detail: env('DAYTONA_API_KEY') ? '✓ present' : '✗ absent (OK only if Daytona was configured in the UI)',
    fix: env('DAYTONA_API_KEY') ? undefined : 'Set DAYTONA_API_KEY (Sandboxes + Snapshots write) and run `npm run setup`.',
  });
  const gh = githubToken();
  add({
    step: 'github token',
    status: gh.token ? 'ok' : 'fail',
    detail: gh.token ? `✓ from ${gh.source}` : '✗ none (GITHUB_TOKEN, GH_TOKEN or `gh auth login`)',
    fix: gh.token ? undefined : 'Set GITHUB_TOKEN or run `gh auth login`, then `npm run setup`.',
  });
  const ghCli = runCapture('gh', ['--version']);
  add({ step: 'gh CLI', status: ghCli.code === 0 ? 'ok' : 'warn', detail: ghCli.code === 0 ? ghCli.stdout.split('\n')[0] : 'not installed (needed for `npm run demo-pr`)', fix: ghCli.code === 0 ? undefined : 'Install GitHub CLI: https://cli.github.com' });
}

// ---------- TrueForge ----------
const reach = await trueforgeReachable();
add({ step: 'trueforge', status: reach.ok ? 'ok' : 'fail', detail: reach.detail, fix: reach.ok ? undefined : `Start it: ${TRUEFORGE_START_CMD}` });

// ---------- pgwarden (direct) ----------
const pgwardenDirect = await probePgwarden();
add(pgwardenDirect);

if (reach.ok) {
  const models = await tf<{ data: Array<{ name: string }> }>('GET', '/models');
  const names = models.ok ? models.body.data.map((m) => m.name) : [];
  add({ step: 'tf: model', status: names.length ? 'ok' : 'fail', detail: names.length ? names.join(', ') : 'no model configured', fix: names.length ? undefined : 'Add model keys to .env and run `npm run setup`.' });

  const sb = await tf<{ data: { status: string; status_reason: string | null } }>('GET', '/settings/sandbox-providers');
  add(
    sb.ok
      ? {
          step: 'tf: sandbox (Daytona)',
          status: sb.body.data.status === 'ready' ? 'ok' : sb.body.data.status === 'pending' ? 'warn' : 'fail',
          detail: `status=${sb.body.data.status}${sb.body.data.status_reason ? ` (${sb.body.data.status_reason})` : ''}`,
          fix: sb.body.data.status === 'ready' ? undefined : 'Wait for the Daytona snapshot build, or re-run `npm run setup` with a valid DAYTONA_API_KEY.',
        }
      : { step: 'tf: sandbox (Daytona)', status: 'fail', detail: 'not configured', fix: 'Set DAYTONA_API_KEY and run `npm run setup` (or Settings → Sandbox providers).' },
  );

  // pgwarden via TrueForge (same path the agent uses)
  const pgReg = await tf('GET', '/settings/mcp-servers/pgwarden');
  if (!pgReg.ok) {
    add({ step: 'tf: mcp pgwarden', status: 'fail', detail: 'not registered', fix: 'Run `npm run setup`.' });
  } else {
    const tools = await tf<{ data: Array<{ name: string }> }>('GET', '/mcp-servers/pgwarden/tools', undefined, 15_000);
    const listed = tools.ok ? tools.body.data.map((t) => t.name) : [];
    const missing = PGWARDEN_TOOLS.filter((t) => !listed.includes(t));
    add(
      tools.ok && !missing.length
        ? { step: 'tf: mcp pgwarden', status: 'ok', detail: 'registered; 6/6 tools via TrueForge' }
        : {
            step: 'tf: mcp pgwarden',
            status: 'fail',
            detail: tools.ok ? `tools missing: ${missing.join(', ')}` : `registered; ${tools.status === 502 ? 'pgwarden not reachable from TrueForge' : tools.error}`,
            fix: /Outbound URL blocked/.test(tools.error ?? '') ? `Restart TrueForge with: ${TRUEFORGE_START_CMD}` : 'Start pgwarden (`npm run pgwarden`); if PGWARDEN_TOKEN changed, re-run `npm run setup`.',
          },
    );
  }

  const ghReg = await tf('GET', '/settings/mcp-servers/github');
  if (!ghReg.ok) {
    add({ step: 'tf: mcp github', status: 'fail', detail: 'not registered', fix: 'Set GITHUB_TOKEN (or `gh auth login`) and run `npm run setup`.' });
  } else {
    // auth_status says "authenticated" for any header value, so actually list tools.
    const tools = await tf<{ data: unknown[] }>('GET', '/mcp-servers/github/tools', undefined, 60_000);
    add(
      tools.ok
        ? { step: 'tf: mcp github', status: 'ok', detail: `registered; ${tools.body.data.length} tools listable` }
        : { step: 'tf: mcp github', status: 'fail', detail: `registered but tools not listable: ${tools.error}`, fix: 'Token rejected? Set a valid GITHUB_TOKEN and re-run `npm run setup`.' },
    );
  }

  const skills = await tf<{ data: Array<{ name: string; manifest?: { ref?: string } }> }>('GET', '/settings/skills');
  const skill = skills.ok ? skills.body.data.find((s) => s.name === 'migration-rehearsal') : undefined;
  if (!skill) {
    add({ step: 'tf: skill', status: 'fail', detail: 'migration-rehearsal not registered', fix: 'Set SKILL_REPO_URL/SKILL_REF and run `npm run setup`.' });
  } else {
    const ref = skill.manifest?.ref;
    const refMatches = !env('SKILL_REF') || ref === env('SKILL_REF');
    add({
      step: 'tf: skill',
      status: refMatches ? 'ok' : 'warn',
      detail: `migration-rehearsal @ ${ref ?? '?'}${refMatches ? '' : ` (SKILL_REF in .env is ${env('SKILL_REF')})`}`,
      fix: refMatches ? undefined : 'Re-run `npm run setup` to pin the skill to SKILL_REF.',
    });
  }

  const agents = await listAgents();
  const agentNames = agents.ok ? agents.body.map((a) => a.name) : [];
  for (const [name, file] of [
    [AGENT_MAIN, 'agent/migration-rehearsal.agent.json'],
    [AGENT_NAIVE, 'agent/migration-rehearsal-naive.agent.json'],
  ] as const) {
    const has = agentNames.includes(name);
    add({
      step: `tf: agent ${name}`,
      status: has ? 'ok' : name === AGENT_NAIVE ? 'warn' : 'fail',
      detail: has ? 'registered' : `not registered${fileExists(file) ? '' : ` (${file} not written yet)`}`,
      fix: has ? undefined : 'Run `npm run setup` once model + github + skill are ✓.',
    });
  }
}

// ---------- DB ----------
if (env('DATABASE_URL') && !isPlaceholder(env('DATABASE_URL'))) {
  const db = await dbReachable();
  add({ step: 'db reachable', status: db.ok ? 'ok' : 'fail', detail: db.detail, fix: db.ok ? undefined : 'Check DATABASE_URL (Neon: include ?sslmode=require).' });
  if (db.ok) {
    try {
      const f = await prodFacts();
      const problems = diffFacts(f, SEEDED);
      add({
        step: 'db seeded',
        status: problems.length ? 'fail' : 'ok',
        detail: problems.length ? `${factsLine(f)}` : 'users 5014, orders 20000, 14 dup groups, no mobile column',
        fix: problems.length ? `Off-contract (${problems.join('; ')}). Run \`npm run reset\`.` : undefined,
      });
    } catch (e) {
      add({ step: 'db seeded', status: 'fail', detail: errMsg(e), fix: 'Run `npm run reset`.' });
    }
  }
} else {
  add({ step: 'db reachable', status: 'fail', detail: 'DATABASE_URL not set', fix: 'Set DATABASE_URL (Neon or any Postgres 16).' });
}

printTable('npm run doctor', rows);
const fails = rows.filter((r) => r.status === 'fail').length;
console.log(fails ? `\n${fails} problem(s). Fix them top to bottom, then re-run \`npm run doctor\`.` : '\nAll green. Next: `npm run reset && npm run e2e -- --runs 1`.');
process.exit(fails ? 1 : 0);

// ---------- helpers ----------
/**
 * Talks MCP (streamable HTTP) to pgwarden directly: initialize → tools/list with the bearer token.
 * Distinguishes "not running" from "running but token rejected".
 */
async function probePgwarden(): Promise<Row> {
  const step = 'pgwarden (direct)';
  const token = env('PGWARDEN_TOKEN');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const rpc = async (body: object, extra: Record<string, string> = {}) => {
    const res = await fetch(PGWARDEN_URL, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    let json: any = null;
    const dataLines = text.split('\n').filter((l) => l.startsWith('data:'));
    try {
      json = dataLines.length ? JSON.parse(dataLines[dataLines.length - 1].slice(5)) : text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { res, json };
  };
  try {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'migration-rehearsal-doctor', version: '1' } },
    });
    if (init.res.status === 401 || init.res.status === 403) {
      return { step, status: 'fail', detail: `running at ${PGWARDEN_URL} but rejected PGWARDEN_TOKEN (${init.res.status})`, fix: 'PGWARDEN_TOKEN in .env must match the one pgwarden was started with; restart pgwarden.' };
    }
    if (!init.res.ok) return { step, status: 'warn', detail: `running at ${PGWARDEN_URL}; initialize returned HTTP ${init.res.status}` };
    const sid = init.res.headers.get('mcp-session-id');
    const extra: Record<string, string> = sid ? { 'mcp-session-id': sid } : {};
    const proto = init.json?.result?.protocolVersion;
    if (proto) extra['mcp-protocol-version'] = proto;
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, extra).catch(() => undefined);
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, extra);
    const names: string[] = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name);
    const missing = PGWARDEN_TOOLS.filter((t) => !names.includes(t));
    return missing.length
      ? { step, status: 'fail', detail: `running; tools missing: ${missing.join(', ')}`, fix: 'pgwarden must expose the 6 tools in CONTRACTS §5.' }
      : { step, status: 'ok', detail: `running at ${PGWARDEN_URL}; 6/6 tools with token` };
  } catch (e) {
    const msg = errMsg(e);
    if (/ECONNREFUSED|fetch failed/.test(msg)) {
      return { step, status: 'fail', detail: `not running (${PGWARDEN_URL})`, fix: 'Start it: `npm run pgwarden` (keep that terminal open).' };
    }
    return { step, status: 'fail', detail: msg };
  }
}
