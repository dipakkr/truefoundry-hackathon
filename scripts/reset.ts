// npm run reset: re-seed "prod" (WS2's seed drops/recreates public + the pgwarden schema),
// then print verify_prod_state-style facts straight from DATABASE_URL. Target < 20s.
import { bold, env, errMsg, fileExists, green, red, runInherit } from './lib/common.js';
import { SEEDED, diffFacts, factsLine, prodFacts } from './lib/db.js';
import { cleanupSandboxes } from './lib/daytona.js';

const t0 = Date.now();
if (!env('DATABASE_URL')) {
  console.error(red('✗ DATABASE_URL is not set in .env'));
  process.exit(1);
}
if (!fileExists('seed/seed.ts')) {
  console.error(red('✗ seed/seed.ts not found (WS2 has not committed it yet)'));
  process.exit(1);
}

const sbx = await cleanupSandboxes();
console.log(sbx.error ? `! Daytona cleanup skipped: ${sbx.error}` : `✓ Daytona: deleted ${sbx.deleted} idle TrueForge sandbox(es), ${sbx.kept} still running`);
console.log(bold('→ npm run seed'));
const code = await runInherit('npm', ['run', '--silent', 'seed']);
if (code !== 0) {
  console.error(red(`✗ seed exited with code ${code}`));
  process.exit(code);
}

try {
  const f = await prodFacts();
  const problems = diffFacts(f, SEEDED);
  console.log(`\n${bold('prod state')}  ${factsLine(f)}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (problems.length) {
    console.error(red(`✗ reset finished in ${secs}s but prod is off-contract: ${problems.join('; ')}`));
    process.exit(1);
  }
  console.log(green(`✓ reset in ${secs}s: users 5014, orders 20000, 14 dup groups, no mobile column`));
} catch (e) {
  console.error(red(`✗ could not read prod facts: ${errMsg(e)}`));
  process.exit(1);
}
