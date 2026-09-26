#!/usr/bin/env node
// CI entry point: start a Migration Rehearsal run in TrueForge for a pull request and mirror its progress
// onto the PR as a commit status. The human approval still happens in TrueForge's own UI.
//
// Env: TRUEFORGE_BASE_URL (default http://localhost:8790), REPO (owner/name), PR_NUMBER, HEAD_SHA,
//      GITHUB_TOKEN (statuses: write), AGENT (default migration-rehearsal), TIMEOUT_MIN (default 30),
//      VIEWER_URL (default http://localhost:8795: the commit status links to the run's live trace there).
//      In GitHub Actions it also writes a job summary: which TrueForge session and agent ran, the agent's
//      progress, and the outcome.
// Runs on a self-hosted runner next to TrueForge, so nothing on the laptop is exposed to the internet.

const TF = (process.env.TRUEFORGE_BASE_URL || 'http://localhost:8790').replace(/\/$/, '');
const { REPO, PR_NUMBER, HEAD_SHA, GITHUB_TOKEN } = process.env;
const AGENT = process.env.AGENT || 'migration-rehearsal';
const DEADLINE = Date.now() + Number(process.env.TIMEOUT_MIN || 30) * 60_000;
const CONTEXT = 'Migration Rehearsal / prod data';
const VIEWER = (process.env.VIEWER_URL || 'http://localhost:8795').replace(/\/$/, '');
const { appendFileSync } = await import('node:fs');
const timeline = [];
function summary(md) { if (process.env.GITHUB_STEP_SUMMARY) try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); } catch {} }

for (const [k, v] of Object.entries({ REPO, PR_NUMBER, HEAD_SHA })) if (!v) fail(`${k} is not set`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
function fail(msg) { console.error(`✗ ${msg}`); process.exit(2); }

async function tf(method, path, body) {
  const res = await fetch(`${TF}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

let lastStatus = '';
let lastDescription = '';
async function status(state, description, targetUrl) {
  const key = `${state}|${description}`;
  if (key === lastStatus) return;
  lastStatus = key;
  lastDescription = `${state === 'success' ? '✅' : state === 'pending' ? '⏳' : '❌'} ${description}`;
  log(`PR status → ${state}: ${description}`);
  if (!GITHUB_TOKEN) return;
  // Best effort, with retries: a flaky network to GitHub must never stop the rehearsal itself.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/statuses/${HEAD_SHA}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
        body: JSON.stringify({ state, description: description.slice(0, 140), context: CONTEXT, target_url: targetUrl }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) log(`! could not set commit status: HTTP ${res.status}`);
      return;
    } catch (e) {
      log(`! commit status attempt ${attempt}/3 failed: ${e.cause?.code || e.message}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
}

// ---- PRs without migration changes pass right away (the check is required for every PR) ----
const MIGRATIONS_PATH = (process.env.MIGRATIONS_PATH || '').replace(/\/+$/, '');
if (MIGRATIONS_PATH && GITHUB_TOKEN) {
  const files = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    }).catch(() => null);
    if (!res?.ok) { files.length = 0; files.push(null); break; } // can't tell: rehearse to be safe
    const batch = await res.json();
    files.push(...batch.map((f) => f.filename));
    if (batch.length < 100) break;
  }
  if (!files.includes(null) && !files.some((f) => f.startsWith(`${MIGRATIONS_PATH}/`))) {
    log(`no files under ${MIGRATIONS_PATH}/ in this PR; nothing to rehearse`);
    summary(`## Migration Rehearsal\n\nNo changes under \`${MIGRATIONS_PATH}/\` in ${REPO}#${PR_NUMBER}: nothing to rehearse, check passes.`);
    await status('success', `No migration changes: nothing to rehearse`);
    process.exit(0);
  }
}

// ---- start ----
const agents = await tf('GET', '/agents').catch((e) => fail(`TrueForge not reachable at ${TF}: ${e.message}`));
if (!(agents.data || []).some((a) => a.name === AGENT)) fail(`agent "${AGENT}" is not registered in TrueForge (run npm run setup)`);

const prompt = `Rehearse PR #${PR_NUMBER} in \`${REPO}\` against prod before we merge. If it's safe, apply it.`;
const session = (await tf('POST', '/sessions', { agent: { name: AGENT } })).data;
const link = `${VIEWER}/#/s/${encodeURIComponent(session.id)}`; // live trace of this run in the dashboard
log(`session ${session.id} started for ${REPO}#${PR_NUMBER}`);
summary([
  '## Migration Rehearsal started in TrueForge',
  '',
  '| | |', '|---|---|',
  `| Pull request | ${REPO}#${PR_NUMBER} (\`${(HEAD_SHA || '').slice(0, 7)}\`) |`,
  `| Agent | \`${AGENT}\` |`,
  `| TrueForge session | \`${session.id}\` on ${TF} |`,
  `| Live trace | ${link} |`,
  `| Prompt | ${prompt} |`,
  '',
].join('\n'));
await status('pending', 'Rehearsing this migration on a masked copy of prod…', link);
// The create-turn call streams (SSE) until the turn pauses or ends, so start it in the background and
// follow progress through the events endpoint instead.
fetch(`${TF}/api/v1/sessions/${session.id}/turns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
  body: JSON.stringify({ input: [{ type: 'user.message', content: prompt }] }),
}).then(async (res) => { if (!res.ok) log(`! create turn → HTTP ${res.status}`); for await (const _ of res.body ?? []) { /* drain */ } }).catch((e) => log(`! create turn: ${e.message}`));

// ---- follow the session ----
const text = (e) => (typeof e.content === 'string' ? e.content : JSON.stringify(e.content ?? ''));
let seen = new Set();
while (Date.now() < DEADLINE) {
  await sleep(4000);
  const events = ((await tf('GET', `/sessions/${session.id}/events?limit=100`)).data || []).map((x) => x.event);
  for (const e of [...events].reverse()) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (e.type === 'model.message' && typeof e.content === 'string' && e.content.trim()) { const line = e.content.trim().split('\n')[0].slice(0, 160); log(`agent: ${line}`); timeline.push(`${new Date().toISOString().slice(11, 19)}  ${line}`); }
    if (e.type === 'tool.approval_required') await status('pending', 'Waiting for human approval in TrueForge (apply_migration)', link);
  }
  const newest = events[0];
  if (!newest || newest.type !== 'turn.done') continue;
  if ((newest.state?.required_actions || []).length) { await status('pending', 'Waiting for human approval in TrueForge (apply_migration)', link); continue; }
  if (newest.state?.status === 'error') { await status('error', `Agent run failed: ${newest.state.message || 'error'}`, link); done(1); }

  // Finished: decide from apply_migration's response (newest first).
  const applyResp = events.find((e) => e.type === 'tool.response' && /committed|POLICY_REFUSED|EFFECTS_MISMATCH|REHEARSAL_|User denied/.test(text(e)));
  const body = applyResp ? text(applyResp) : '';
  if (/"status":"committed"/.test(body)) { await status('success', 'Rehearsed, approved, applied and verified on prod', link); done(0); }
  if (/User denied/.test(body)) { await status('failure', 'Approval denied in TrueForge. Prod unchanged', link); done(1); }
  const code = (body.match(/POLICY_REFUSED|EFFECTS_MISMATCH|REHEARSAL_[A-Z_]+/) || [])[0];
  if (code) { await status('failure', `pgwarden refused (${code}). Prod unchanged`, link); done(1); }
  await status('failure', 'Not applied: rehearsal did not pass or the agent stopped. See the PR comment', link);
  done(1);
}
await status('error', 'Timed out waiting for the rehearsal or the approval', link);
done(1);

function done(code) {
  summary(['### Outcome', '', lastDescription, '', '### Agent progress', '', '```', ...timeline, '```'].join('\n'));
  process.exit(code);
}
