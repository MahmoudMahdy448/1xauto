import { execSync, spawn } from 'child_process';
import dotenv from 'dotenv';
import { emit } from '../lib/events.js';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');
const lowMemory = process.env.LOW_MEMORY === 'true';
const skipNotify = process.env.SKIP_NOTIFY === 'true';
const env = {
  ...process.env,
  HEADLESS: process.env.HEADED === 'true' ? 'false' : 'true',
  ALLOW_LIVE_RUN: 'true',
  ...(dryRun ? { DRY_RUN: 'true' } : {}),
  ...(lowMemory ? { LOW_MEMORY: 'true' } : {})
};

console.log(`[scheduled-run] starting batch ${new Date().toISOString()}`);

let realtimeChild = null;

function startRealtimeSender() {
  // Start the real-time screenshot sender so new numbers go to Telegram
  // immediately as they are captured, instead of waiting for the whole batch.
  realtimeChild = spawn(process.execPath, ['scripts/realtime-send.mjs'], {
    stdio: 'inherit',
    env: { ...env, EVENT_ROLE: 'sender' }
  });
  realtimeChild.on('error', (err) => {
    console.error(`[scheduled-run] realtime-send error: ${err.message}`);
  });
  emit({ kind: 'sender.started', data: { component: 'realtime-send', pid: realtimeChild.pid } });
  console.log('[scheduled-run] realtime-send started (screenshots sent as captured)');
}

function stopRealtimeSender() {
  if (realtimeChild) {
    try {
      realtimeChild.kill('SIGTERM');
    } catch {
      // already gone
    }
    realtimeChild = null;
    emit({ kind: 'sender.stopped', data: { component: 'realtime-send', reason: 'batch-finished' } });
    console.log('[scheduled-run] realtime-send stopped');
  }
}

// Notify runs once, as the final pass below: running it here as a step too
// posted the batch summary twice, because notify sends the summary before it
// checks whether there is anything new to send.
const steps = [
  ['login', 'npm run login'],
  ['excel', 'npm run excel']
];
if (skipNotify) {
  console.log('[scheduled-run] SKIP_NOTIFY=true — per-shard notification skipped (collector handles it).');
}

let failed = false;

for (const [name, cmd] of steps) {
  console.log(`[scheduled-run] step: ${name}`);

  // Start real-time sender before the login (Playwright) step so screenshots
  // are sent to Telegram as they are captured.
  if (name === 'login' && !dryRun) {
    startRealtimeSender();
  }

  try {
    execSync(cmd, {
      stdio: 'inherit',
      env: name === 'login' ? { ...env, EVENT_ROLE: 'scrape' } : env,
      cwd: process.cwd()
    });
  } catch (error) {
    console.error(`[scheduled-run] step ${name} failed: ${error.message}`);
    failed = true;
  }

  // Stop real-time sender after login (Playwright) finishes.
  if (name === 'login') {
    stopRealtimeSender();
  }
}

// Final notify pass: catches anything the real-time sender missed, sends the
// batch summary to the admin chat, and sends any leftover screenshots.
if (!skipNotify) {
  try {
    execSync('node scripts/notify.js', { stdio: 'inherit', env, cwd: process.cwd() });
  } catch (error) {
    console.error(`[scheduled-run] step notify failed: ${error.message}`);
    failed = true;
  }
}

// Ensure realtime sender is not left running.
stopRealtimeSender();

console.log(`[scheduled-run] finished ${new Date().toISOString()}${failed ? ' (with failures)' : ''}`);
process.exit(failed ? 1 : 0);
