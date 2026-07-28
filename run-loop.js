import { execSync } from 'child_process';

const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES, 10) || 10;
const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1000;
const START_INDEX = process.env.START_INDEX || '1';
const HEADLESS = 'true';

process.env.START_INDEX = START_INDEX;
process.env.HEADLESS = HEADLESS;

let run = 0;

while (true) {
  run += 1;
  console.log(`[Run #${run}] Starting from index ${START_INDEX}...`);

  try {
    execSync('npm run login', { stdio: 'inherit', env: process.env });
    console.log(`[Run #${run}] Done`);
  } catch {
    console.log(`[Run #${run}] Finished with errors`);
  }

  console.log(`Cooling down ${COOLDOWN_MINUTES}min...`);
  await new Promise((r) => setTimeout(r, COOLDOWN_MS));
}
