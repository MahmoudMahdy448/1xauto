import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES, 10) || 10;
const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1000;
const START_INDEX = process.env.START_INDEX || '1';
const HEADLESS = 'true';
const ALLOW_LIVE_RUN = 'true';
const STATUS_FILE = path.resolve(process.cwd(), process.env.STATUS_FILE || 'loop-status.json');

process.env.START_INDEX = START_INDEX;
process.env.HEADLESS = HEADLESS;
process.env.ALLOW_LIVE_RUN = ALLOW_LIVE_RUN;

function writeStatus(state, nextRunAt) {
  const status = {
    state,
    startIndex: parseInt(START_INDEX, 10) || 1,
    cooldownMinutes: COOLDOWN_MINUTES,
    run: 0,
    updatedAt: new Date().toISOString(),
    nextRunAt
  };

  try {
    if (existsSync(STATUS_FILE)) {
      const existing = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
      if (existing && typeof existing.run === 'number') {
        status.run = existing.run;
      }
    }
  } catch {
    // no previous status
  }

  writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

let run = 0;

writeStatus('starting', null);

while (true) {
  run += 1;
  console.log(`[Run #${run}] Starting from index ${START_INDEX}...`);

  try {
    const existing = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
    existing.run = run;
    existing.state = 'running';
    existing.updatedAt = new Date().toISOString();
    existing.nextRunAt = null;
    writeFileSync(STATUS_FILE, JSON.stringify(existing, null, 2));
  } catch {
    writeStatus('running', null);
  }

  try {
    execSync('node scripts/scheduled-run.mjs', { stdio: 'inherit', env: process.env });
    console.log(`[Run #${run}] Done`);
  } catch {
    console.log(`[Run #${run}] Finished with errors`);
  }

  const nextRunAt = new Date(Date.now() + COOLDOWN_MS).toISOString();
  writeStatus('cooldown', nextRunAt);
  console.log(`Cooling down ${COOLDOWN_MINUTES}min... (next run ${nextRunAt})`);
  await new Promise((r) => setTimeout(r, COOLDOWN_MS));
}
