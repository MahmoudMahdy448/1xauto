// Keeps seen-numbers.json in sync with the Telegram channel history.
// Runs scripts/telegram-sync.mjs on an interval until stopped.
//
//   node scripts/telegram-sync-loop.mjs
//
// SYNC_INTERVAL_MINUTES (default 360 = every 6h).
// While telegram-session.txt does not exist yet it waits instead of exiting,
// so you can start it together with the shards and log in later.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const intervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || 360;
const intervalMs = intervalMinutes * 60 * 1000;
const sessionPath = path.resolve(process.cwd(), process.env.TELEGRAM_SESSION_FILE || 'telegram-session.txt');
const waitMs = 10 * 60 * 1000;

function runSync() {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/telegram-sync.mjs'], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', (error) => {
      console.error(`[telegram-sync-loop] failed to start: ${error.message}`);
      resolve(false);
    });
  });
}

while (true) {
  if (!existsSync(sessionPath)) {
    console.log(`[telegram-sync-loop] waiting for ${path.basename(sessionPath)} — run "node scripts/telegram-login.mjs" once`);
    await new Promise((r) => setTimeout(r, waitMs));
    continue;
  }

  await runSync();
  console.log(`[telegram-sync-loop] next sync in ${intervalMinutes} min`);
  await new Promise((r) => setTimeout(r, intervalMs));
}
