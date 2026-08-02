import { execSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');
const env = { ...process.env, HEADLESS: 'true', ALLOW_LIVE_RUN: 'true', ...(dryRun ? { DRY_RUN: 'true' } : {}) };

console.log(`[scheduled-run] starting batch ${new Date().toISOString()}`);

const steps = [
  ['login', 'npm run login'],
  ['excel', 'npm run excel'],
  ['notify', 'node scripts/notify.js']
];

let failed = false;

for (const [name, cmd] of steps) {
  console.log(`[scheduled-run] step: ${name}`);
  try {
    execSync(cmd, { stdio: 'inherit', env, cwd: process.cwd() });
  } catch (error) {
    console.error(`[scheduled-run] step ${name} failed: ${error.message}`);
    failed = true;
  }
}

console.log(`[scheduled-run] finished ${new Date().toISOString()}${failed ? ' (with failures)' : ''}`);
process.exit(failed ? 1 : 0);
