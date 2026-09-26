// npm run setup: idempotent registration of everything the agent needs in TrueForge.
// Every PUT below is create-or-replace (verified against the real API); safe to re-run.
// Never prints secret values.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_MAIN,
  AGENT_NAIVE,
  PGWARDEN_TOOLS,
  PGWARDEN_URL,
  REPO_ROOT,
  Row,
  TRUEFORGE_START_CMD,
  env,
  githubToken,
  isPlaceholder,
  printTable,
  red,
  bold,
} from './lib/common.js';
import { hintFor, listAgents, loadAgentFile, modelFqn, modelMode, resourceSlug, tf, trueforgeReachable, CATALOG_PROVIDERS } from './lib/trueforge.js';

const rows: Row[] = [];
const add = (r: Row) => {
  rows.push(r);
  const mark = { ok: '✓', warn: '!', fail: '✗', skip: '–' }[r.status];
  console.log(`${mark} ${r.step}: ${r.detail}`);
};

// ---------- 0. TrueForge reachable ----------
const reach = await trueforgeReachable();
if (!reach.ok) {
  console.error(red(`✗ TrueForge: ${reach.detail}`));
  console.error(`  Start it in another terminal:\n    ${TRUEFORGE_START_CMD}`);
  process.exit(1);
}
console.log(bold(`TrueForge at ${reach.detail}`));

// ---------- 1. Model provider ----------
let fqn: string | undefined;
{
  const mode = modelMode();
  if (mode === 'tfy-gateway') {
    const modelId = env('MODEL_ID')!;
    const manifest = {
      type: 'custom',
      name: 'tfy-gateway',
      base_url: env('TFY_GATEWAY_BASE_URL')!,
      auth: { api_key: env('TFY_GATEWAY_API_KEY')! },
      models: [
        {
          name: resourceSlug(modelId),
          model_id: modelId,
          properties: { context_length: Number(env('MODEL_CONTEXT_LENGTH') ?? 128000) },
        },
      ],
    };
    const r = await tf('PUT', '/settings/model-providers', { manifest });
    fqn = modelFqn();
    add(
      r.ok
        ? { step: 'model provider', status: 'ok', detail: `tfy-gateway (custom) → ${fqn}` }
        : { step: 'model provider', status: 'fail', detail: `PUT tfy-gateway: ${r.error}`, fix: hintFor(r.error) ?? 'Check TFY_GATEWAY_BASE_URL (OpenAI-compatible base URL, public host).' },
    );
  } else if (mode === 'openai' || mode === 'anthropic') {
    const cat = await tf<{ data: Array<{ type: string; models: Array<{ name: string; model_id: string; properties: object }> }> }>('GET', '/catalogs/model-providers');
    const catalogModels = cat.ok ? (cat.body.data.find((p) => p.type === mode)?.models ?? []) : [];
    const wanted = env('MODEL_ID') ?? CATALOG_PROVIDERS[mode].model;
    const models = [...catalogModels];
    if (!models.some((m) => m.model_id === wanted || m.name === wanted)) {
      models.push({ name: resourceSlug(wanted), model_id: wanted, properties: {} });
    }
    const r = await tf('PUT', '/settings/model-providers', {
      manifest: { type: mode, auth: { api_key: env(CATALOG_PROVIDERS[mode].key)! }, models },
    });
    fqn = modelFqn(models);
    add(
      r.ok
        ? { step: 'model provider', status: 'ok', detail: `${mode} (catalog) → ${fqn}` }
        : { step: 'model provider', status: 'fail', detail: `PUT ${mode}: ${r.error}`, fix: hintFor(r.error) },
    );
  } else {
    // Maybe configured earlier via the UI: reuse it if MODEL_FQN points at an existing model.
    const models = await tf<{ data: Array<{ name: string }> }>('GET', '/models');
    const existing = models.ok ? models.body.data.map((m) => m.name) : [];
    fqn = env('MODEL_FQN');
    if (fqn && existing.includes(fqn)) {
      add({ step: 'model provider', status: 'ok', detail: `no model keys in .env; using existing ${fqn} (MODEL_FQN)` });
    } else {
      add({
        step: 'model provider',
        status: 'fail',
        detail: `no model keys in .env${existing.length ? `; TrueForge has ${existing.join(', ')} (set MODEL_FQN to use one)` : ''}`,
        fix: 'Set TFY_GATEWAY_BASE_URL + TFY_GATEWAY_API_KEY + MODEL_ID (preferred) or OPENAI_API_KEY or ANTHROPIC_API_KEY in .env, then re-run `npm run setup`.',
      });
      fqn = undefined;
    }
  }
}

// ---------- 2. Sandbox provider (Daytona) ----------
{
  const key = env('DAYTONA_API_KEY');
  if (key && !isPlaceholder(key)) {
    const cat = await tf<{ data: Array<Record<string, unknown>> }>('GET', '/catalogs/sandbox-providers');
    const defaults = (cat.ok && cat.body.data.find((p) => p.type === 'daytona')) || {};
    const manifest = {
      type: 'daytona',
      auth: { api_key: key },
      exec_timeout_ms: Math.max(Number(defaults.exec_timeout_ms ?? 60000), 120000), // pg boot + load can exceed 60s
      auto_stop_interval_in_minutes: Number(defaults.auto_stop_interval_in_minutes ?? 5),
      auto_archive_interval_in_minutes: Number(defaults.auto_archive_interval_in_minutes ?? 60),
      auto_delete_interval_in_minutes: Number(env('DAYTONA_AUTO_DELETE_MINUTES') ?? 30), // free tier: 30 GiB total, 3 GiB per sandbox
    };
    const r = await tf<{ data: { status: string; status_reason: string | null } }>('PUT', '/settings/sandbox-providers', { manifest }, 60_000);
    add(
      r.ok
        ? { step: 'sandbox (Daytona)', status: r.body.data.status === 'failed' ? 'fail' : 'ok', detail: `status=${r.body.data.status}${r.body.data.status_reason ? ` (${r.body.data.status_reason})` : ''}` }
        : { step: 'sandbox (Daytona)', status: 'fail', detail: r.error ?? 'PUT failed', fix: hintFor(r.error) },
    );
  } else {
    const cur = await tf<{ data: { status: string } }>('GET', '/settings/sandbox-providers');
    add(
      cur.ok
        ? { step: 'sandbox (Daytona)', status: 'ok', detail: `already configured (status=${cur.body.data.status}); DAYTONA_API_KEY not in .env` }
        : {
            step: 'sandbox (Daytona)',
            status: 'fail',
            detail: 'DAYTONA_API_KEY not set and no sandbox provider configured',
            fix: 'Set DAYTONA_API_KEY (Sandboxes + Snapshots write) and re-run, or configure it once in the UI: Settings → Sandbox providers → Daytona.',
          },
    );
  }
}

// ---------- 3. pgwarden MCP (remote, header auth) ----------
{
  const token = env('PGWARDEN_TOKEN');
  if (!token || isPlaceholder(token)) {
    add({ step: 'mcp: pgwarden', status: 'fail', detail: 'PGWARDEN_TOKEN missing or still a placeholder', fix: 'Set PGWARDEN_TOKEN (random 32+ chars) in .env.' });
  } else {
    const manifest = {
      type: 'remote',
      name: 'pgwarden',
      url: PGWARDEN_URL,
      description: 'Migration Rehearsal gatekeeper for the prod Postgres: schema/profile/masked export (read-only), rehearsal records, and the human-gated apply_migration.',
      auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } },
    };
    const r = await tf('PUT', '/settings/mcp-servers', { manifest });
    if (!r.ok) {
      add({ step: 'mcp: pgwarden', status: 'fail', detail: r.error ?? 'PUT failed', fix: hintFor(r.error) });
    } else {
      const tools = await tf<{ data: Array<{ name: string }> }>('GET', '/mcp-servers/pgwarden/tools', undefined, 15_000);
      if (tools.ok) {
        const names = tools.body.data.map((t) => t.name);
        const missing = PGWARDEN_TOOLS.filter((t) => !names.includes(t));
        add(
          missing.length
            ? { step: 'mcp: pgwarden', status: 'warn', detail: `registered; tools missing: ${missing.join(', ')}`, fix: 'pgwarden is running but does not expose all 6 tools (CONTRACTS §5).' }
            : { step: 'mcp: pgwarden', status: 'ok', detail: `registered at ${PGWARDEN_URL}; 6/6 tools listed` },
        );
      } else {
        add({
          step: 'mcp: pgwarden',
          status: 'warn',
          detail: `registered at ${PGWARDEN_URL}; tools not listable (${tools.status === 502 ? 'pgwarden not running' : tools.error})`,
          fix: 'Start pgwarden: `npm run pgwarden` (then `npm run doctor`).',
        });
      }
    }
  }
}

// ---------- 4. GitHub MCP (catalog entry; header auth with a PAT) ----------
{
  const cat = await tf<{ data: Array<{ name: string; url: string; description: string; type: string; auth?: { type: string; headers?: Record<string, string> } }> }>(
    'GET',
    '/catalogs/mcp-servers',
  );
  const entry = cat.ok ? cat.body.data.find((e) => e.name === 'github') : undefined;
  const { token, source } = githubToken();
  if (!entry) {
    add({ step: 'mcp: github', status: 'fail', detail: `no "github" entry in /catalogs/mcp-servers (${cat.error ?? 'not found'})` });
  } else if (!token) {
    const cur = await tf('GET', '/settings/mcp-servers/github');
    add(
      cur.ok
        ? { step: 'mcp: github', status: 'ok', detail: 'kept existing registration (no token in env to rotate)' }
        : {
            step: 'mcp: github',
            status: 'fail',
            detail: `catalog entry uses header auth (PAT), and no token found`,
            fix: 'Set GITHUB_TOKEN (PAT with repo read + PR comment on the shopkart repo) or run `gh auth login`, then re-run `npm run setup`.',
          },
    );
  } else {
    // Catalog: {type: remote, url: https://api.githubcopilot.com/mcp/, auth: {type: header, headers: {Authorization: "Bearer YOUR_GITHUB_PAT"}}}
    const manifest: Record<string, unknown> = { type: 'remote', name: 'github', url: entry.url, description: entry.description };
    if (entry.auth?.type === 'dcr') manifest.auth = { type: 'dcr' };
    else manifest.auth = { type: 'header', headers: { Authorization: `Bearer ${token}` } };
    const r = await tf('PUT', '/settings/mcp-servers', { manifest });
    if (!r.ok) {
      add({ step: 'mcp: github', status: 'fail', detail: r.error ?? 'PUT failed', fix: hintFor(r.error) });
    } else if (entry.auth?.type === 'dcr') {
      add({ step: 'mcp: github', status: 'warn', detail: 'registered (OAuth)', fix: 'Open the chat once and click **Connect** for GitHub.' });
    } else {
      const tools = await tf<{ data: Array<{ name: string }> }>('GET', '/mcp-servers/github/tools', undefined, 60_000);
      add(
        tools.ok
          ? { step: 'mcp: github', status: 'ok', detail: `registered (token from ${source}); ${tools.body.data.length} tools listed` }
          : { step: 'mcp: github', status: 'warn', detail: `registered (token from ${source}); tools not listable: ${tools.error}`, fix: 'Token rejected by GitHub MCP? Use a PAT with repo access to SHOPKART_REPO.' },
      );
    }
  }
}

// ---------- 5. Skill (git) ----------
{
  const url = env('SKILL_REPO_URL');
  const ref = env('SKILL_REF') ?? 'main';
  if (!url || isPlaceholder(url)) {
    add({ step: 'skill: migration-rehearsal', status: 'fail', detail: 'SKILL_REPO_URL missing or still a placeholder', fix: 'Set SKILL_REPO_URL=https://github.com/<you>/truefoundry-hackathon (public) and SKILL_REF.' });
  } else {
    let description = 'Rehearse a Postgres migration PR on a masked copy of prod in the sandbox, then apply it only through pgwarden apply_migration with declared effects.';
    const skillMd = resolve(REPO_ROOT, 'skills/migration-rehearsal/SKILL.md');
    if (existsSync(skillMd)) {
      const m = readFileSync(skillMd, 'utf8').match(/^---[\s\S]*?^description:\s*(.+)$[\s\S]*?^---/m);
      if (m) description = m[1].trim().replace(/^["']|["']$/g, '');
    }
    const manifest = { type: 'git', name: 'migration-rehearsal', url, path: 'skills/migration-rehearsal', ref, description };
    const r = await tf('PUT', '/settings/skills', { manifest });
    if (!r.ok) {
      add({ step: 'skill: migration-rehearsal', status: 'fail', detail: r.error ?? 'PUT failed', fix: hintFor(r.error) ?? 'SKILL_REPO_URL must be https://github.com/<owner>/<repo>; SKILL_REF a branch/tag/SHA.' });
    } else {
      const v = await tf<{ data: Array<{ version: number }> }>('GET', '/skills/versions?name=migration-rehearsal');
      const n = v.ok ? v.body.data.length : 0;
      add({ step: 'skill: migration-rehearsal', status: 'ok', detail: `registered @ ${ref}${n ? ` (${n} version(s) resolved)` : ' (resolves when the repo is pushed + public)'}` });
    }
  }
}

// ---------- 6. Agents ----------
const agentsRes = await listAgents();
const existing = new Map((agentsRes.ok ? agentsRes.body : []).map((a) => [a.name, a]));
for (const [name, file] of [
  [AGENT_MAIN, 'agent/migration-rehearsal.agent.json'],
  [AGENT_NAIVE, 'agent/migration-rehearsal-naive.agent.json'],
] as const) {
  const step = `agent: ${name}`;
  if (!fqn) {
    add({ step, status: 'fail', detail: 'blocked: no model configured (TrueForge rejects agents whose model is unknown)', fix: 'Configure a model (see "model provider") and re-run.' });
    continue;
  }
  const loaded = loadAgentFile(file, name, { MODEL_FQN: fqn, MODEL_ID: env('MODEL_ID') });
  if (!loaded.ok) {
    add({ step, status: 'fail', detail: loaded.error, fix: `Wait for WS3 to commit ${file}, then re-run.` });
    continue;
  }
  const { agent } = loaded;
  if (agent.name !== name) console.log(`  note: ${file} names the agent "${agent.name}"; registering as "${name}"`);
  const prior = existing.get(name);
  const r = prior
    ? await tf('PUT', `/agents/${prior.id}`, { description: agent.description, manifest: agent.manifest })
    : await tf('POST', '/agents', { name, description: agent.description, manifest: agent.manifest });
  const warnUnresolved = agent.unresolved.length ? `; unresolved placeholders: ${agent.unresolved.join(', ')}` : '';
  add(
    r.ok
      ? { step, status: warnUnresolved ? 'warn' : 'ok', detail: `${prior ? 'updated' : 'created'} (model ${agent.manifest.model.name})${warnUnresolved}`, fix: warnUnresolved ? 'Set the missing vars in .env and re-run.' : undefined }
      : { step, status: 'fail', detail: `${prior ? 'PUT' : 'POST'} ${r.status}: ${r.error}`, fix: hintFor(r.error) },
  );
}

// ---------- summary ----------
printTable('npm run setup', rows);
console.log(
  `\nGitHub: TrueForge's catalog entry is header-auth (PAT), so there is no in-chat Connect step; setup injects the token.\n` +
    `Daytona can also be configured once in the UI: ${reach.detail}/ → Settings → Sandbox providers.`,
);
process.exit(rows.some((r) => r.status === 'fail') ? 1 : 0);
