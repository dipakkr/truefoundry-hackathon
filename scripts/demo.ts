// npm run demo: start pgwarden (foreground) and remind you about TrueForge.
import { spawn } from 'node:child_process';
import { REPO_ROOT, bold, yellow } from './lib/common.js';
import { trueforgeReachable } from './lib/trueforge.js';

const tf = await trueforgeReachable();
if (!tf.ok) {
  console.log(yellow(`! TrueForge is not running (${tf.detail}).`));
  console.log(yellow('  Start it in another terminal:  npm run trueforge'));
} else {
  console.log(bold(`TrueForge up at ${tf.detail}`));
}
console.log(bold('Starting pgwarden (Ctrl-C to stop)…'));
const child = spawn('npm', ['--prefix', 'pgwarden', 'run', 'start'], { cwd: REPO_ROOT, stdio: 'inherit', env: process.env });
const stop = (sig: NodeJS.Signals) => child.kill(sig);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
