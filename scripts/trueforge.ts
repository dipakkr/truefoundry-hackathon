// npm run trueforge [-- --fresh]: start local TrueForge on :8790 with the one setting this project needs.
// TrueForge's outbound SSRF guard blocks localhost by default, which would reject the pgwarden
// MCP URL (http://localhost:8787/mcp) with `Outbound URL blocked for host "localhost"`.
// --fresh uses a throwaway SQLite file under the OS temp dir (clean data dir for e2e "fresh install" checks).
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { bold, parseArgs } from './lib/common.js';

const VERSION = process.env.TRUEFORGE_VERSION ?? '0.2.1';
const args = parseArgs(process.argv.slice(2));
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OUTBOUND_URL_ALLOWED_HOSTS: process.env.OUTBOUND_URL_ALLOWED_HOSTS ?? '["localhost","127.0.0.1"]',
};
// TrueForge keeps Code Mode sockets in $TMPDIR/tf_cms, shared by every instance on the machine; stopping
// one instance deletes it and breaks the others ("codeModeSocketParentPath must be an existing directory").
// Give each port its own short TMPDIR (the socket parent path must stay ≤ 65 bytes).
if (process.platform !== 'win32' && !process.env.TRUEFORGE_KEEP_TMPDIR) {
  const tmp = `/tmp/trueforge-${process.env.PORT ?? '8790'}`;
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  childEnv.TMPDIR = tmp;
}
if (args.fresh) {
  const dir = resolve(tmpdir(), `trueforge-fresh-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  childEnv.SQLITE_PATH = resolve(dir, 'db.sqlite');
  console.log(bold(`fresh data dir: ${dir}`));
}
console.log(bold(`starting @truefoundry/trueforge@${VERSION} (OUTBOUND_URL_ALLOWED_HOSTS=${childEnv.OUTBOUND_URL_ALLOWED_HOSTS})`));
const child = spawn('npx', ['-y', `@truefoundry/trueforge@${VERSION}`], { stdio: 'inherit', env: childEnv });
const stop = (sig: NodeJS.Signals) => child.kill(sig);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
