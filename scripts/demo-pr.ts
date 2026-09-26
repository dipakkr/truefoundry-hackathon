// npm run demo-pr [-- --dry-run] [--repo owner/shopkart] [--dir ../shopkart] [--force]
// Publishes the local shopkart repo to GitHub and opens the two demo PRs:
//   PR #1  feat/contact-cleanup          (stage; must stay free of bot comments)
//   PR #2  feat/contact-cleanup-e2e      (title "[e2e] …"; the e2e runner comments here)
// Idempotent: an existing repo / pushed branch / open PR is reused, not duplicated.
// --dry-run prints every gh/git command and runs nothing that talks to GitHub.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, bold, env, green, isPlaceholder, parseArgs, red, runCapture, yellow } from './lib/common.js';

const args = parseArgs(process.argv.slice(2));
const DRY = Boolean(args['dry-run']);
const FORCE = Boolean(args.force);
const repo = String(args.repo ?? env('SHOPKART_REPO') ?? '');
const dir = resolve(REPO_ROOT, String(args.dir ?? '../shopkart'));

const BASE = 'main';
const PRS = [
  { branch: 'feat/contact-cleanup', expect: 1, prefix: '' },
  { branch: 'feat/contact-cleanup-e2e', expect: 2, prefix: '[e2e] ' },
] as const;
const DEFAULT_TITLE = 'Contact cleanup: unique emails (case-insensitive) + rename phone → mobile';
const DEFAULT_BODY = [
  'Migration `migrations/0007_contact_cleanup.sql`:',
  '',
  '- `CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));`',
  '- `ALTER TABLE users RENAME COLUMN phone TO mobile;`',
  '',
  'CI (0001–0007 on an empty Postgres) is green.',
].join('\n');

const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const show = (cmd: string, argv: string[]) => console.log(`  $ ${[cmd, ...argv].map(q).join(' ')}`);

/** Read-only local command (git on the local repo): always executed. */
function local(cmd: string, argv: string[]) {
  return runCapture(cmd, argv, { cwd: existsSync(dir) ? dir : REPO_ROOT });
}

/** Command that talks to GitHub or mutates state: printed, and executed unless --dry-run. */
function remote(cmd: string, argv: string[], opts: { allowFail?: boolean } = {}): { code: number; stdout: string; stderr: string } {
  show(cmd, argv);
  if (DRY) return { code: 0, stdout: '', stderr: '' };
  const r = runCapture(cmd, argv, { cwd: existsSync(dir) ? dir : REPO_ROOT });
  if (r.code !== 0 && !opts.allowFail) {
    console.error(red(`✗ ${cmd} ${argv[0]} failed (${r.code}): ${r.stderr || r.stdout}`));
    process.exit(1);
  }
  return r;
}

/** Query against GitHub: executed only when not dry-run; in dry-run we print it and assume "absent". */
function query(cmd: string, argv: string[]) {
  show(cmd, argv);
  if (DRY) return { code: 1, stdout: '', stderr: 'dry-run' };
  return runCapture(cmd, argv, { cwd: existsSync(dir) ? dir : REPO_ROOT });
}

console.log(bold(`demo-pr${DRY ? ' (dry run: printing commands only)' : ''}`));

// ---------- preflight ----------
if (!repo || isPlaceholder(repo) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error(red(`✗ SHOPKART_REPO must be "<github-user>/shopkart" (got "${repo || 'unset'}")`));
  if (!DRY) process.exit(1);
}
const gh = runCapture('gh', ['--version']);
if (gh.code !== 0) {
  console.error(red('✗ GitHub CLI `gh` not found: https://cli.github.com'));
  if (!DRY) process.exit(1);
}
if (!DRY) {
  const auth = runCapture('gh', ['auth', 'status']);
  if (auth.code !== 0) {
    console.error(red('✗ `gh` is not logged in: run `gh auth login`'));
    process.exit(1);
  }
}
const haveDir = existsSync(resolve(dir, '.git'));
if (!haveDir) {
  const msg = `local shopkart repo not found at ${dir} (WS2 creates it)`;
  if (DRY) console.log(yellow(`! ${msg}; continuing the dry run`));
  else {
    console.error(red(`✗ ${msg}`));
    process.exit(1);
  }
} else {
  for (const b of [BASE, ...PRS.map((p) => p.branch)]) {
    const r = local('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
    if (r.code !== 0) {
      const msg = `branch ${b} missing in ${dir}`;
      if (DRY) console.log(yellow(`! ${msg}`));
      else {
        console.error(red(`✗ ${msg}`));
        process.exit(1);
      }
    }
  }
}

// ---------- 1. repo ----------
console.log(bold('\n1. GitHub repo'));
const view = query('gh', ['repo', 'view', repo, '--json', 'name']);
if (view.code === 0) console.log(green(`  ✓ ${repo} exists`));
else remote('gh', ['repo', 'create', repo, '--public', '--description', 'Migration Rehearsal demo target (shopkart)']);

// ---------- 2. push ----------
console.log(bold('\n2. Push branches (main first)'));
// Prefer SSH: the gh HTTPS token often lacks the `workflow` scope needed to push .github/workflows/ci.yml.
const sshOk = query('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'git@github.com']).stderr.includes('successfully authenticated');
if (!sshOk) remote('gh', ['auth', 'setup-git']);
const url = sshOk ? `git@github.com:${repo}.git` : `https://github.com/${repo}.git`;
if (!sshOk) console.log('  (pushing over HTTPS; if it fails on the workflow file, run `gh auth refresh -s workflow`)');
const pushFlags = FORCE ? ['--force'] : [];
remote('git', ['-C', dir, 'push', ...pushFlags, url, `refs/heads/${BASE}:refs/heads/${BASE}`]);
remote('gh', ['repo', 'edit', repo, '--default-branch', BASE], { allowFail: true });
for (const p of PRS) remote('git', ['-C', dir, 'push', ...pushFlags, url, `refs/heads/${p.branch}:refs/heads/${p.branch}`]);

// ---------- 3. PRs ----------
console.log(bold('\n3. Pull requests'));
const numbers: Record<string, number | undefined> = {};
for (const p of PRS) {
  const existing = query('gh', ['pr', 'list', '--repo', repo, '--head', p.branch, '--state', 'all', '--json', 'number,state,title']);
  const found = existing.code === 0 && existing.stdout ? (JSON.parse(existing.stdout) as Array<{ number: number; state: string }>) : [];
  const open = found.find((x) => x.state === 'OPEN') ?? found[0];
  if (open) {
    numbers[p.branch] = open.number;
    console.log(green(`  ✓ ${p.branch}: PR #${open.number} (${open.state.toLowerCase()}) already exists`));
    continue;
  }
  const subject = haveDir ? local('git', ['log', '-1', '--format=%s', `refs/heads/${p.branch}`]).stdout : '';
  const title = `${p.prefix}${subject || DEFAULT_TITLE}`;
  const body = p.prefix ? `${DEFAULT_BODY}\n\n_Identical copy of PR #1 used by the automated e2e runner, so PR #1 stays clean for the live demo._` : DEFAULT_BODY;
  const r = remote('gh', ['pr', 'create', '--repo', repo, '--base', BASE, '--head', p.branch, '--title', title, '--body', body]);
  const m = r.stdout.match(/\/pull\/(\d+)/);
  numbers[p.branch] = m ? Number(m[1]) : DRY ? p.expect : undefined;
}

// ---------- 4. verify numbering ----------
console.log(bold('\n4. Check PR numbers'));
let ok = true;
for (const p of PRS) {
  const n = numbers[p.branch];
  if (n === p.expect) console.log(green(`  ✓ ${p.branch} is PR #${n}`));
  else {
    ok = false;
    console.log(yellow(`  ! ${p.branch} is PR #${n ?? '?'} (expected #${p.expect})`));
  }
}
if (!ok) {
  console.log(
    yellow(
      `  The stage prompt uses PR_NUMBER=1 and e2e uses --pr 2. Either set PR_NUMBER / pass --pr to the real numbers,\n` +
        `  or recreate ${repo} fresh (issues and PRs share one counter).`,
    ),
  );
}
console.log(DRY ? '\nDry run complete: nothing was sent to GitHub.' : `\nDone: https://github.com/${repo}/pulls`);
