import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES, 10) || 10;
const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1000;
const START_INDEX = process.env.START_INDEX || '1';
const HEADLESS = 'true';
const ALLOW_LIVE_RUN = 'true';
const STATUS_FILE = path.resolve(process.cwd(), process.env.STATUS_FILE || 'loop-status.json');
const GROUP = process.env.RUN_GROUP || 'A';
const LEASE_FILE = process.env.LEASE_FILE || null;
const LEASE_MS = 2 * 60 * 60 * 1000;
const HEARTBEAT_MS = 2 * 60 * 1000;
const PREEMPT_CHECK_MS = 15 * 1000;
const RELEASE_BUFFER_MS = 5 * 60 * 1000;
const PRIORITY_GROUP = process.env.PRIORITY_GROUP || 'A';
const NOTIFY_INTERVAL_MS = (parseInt(process.env.NOTIFY_INTERVAL_MINUTES, 10) || (process.env.SKIP_NOTIFY === 'true' ? 0 : 15)) * 60 * 1000;

process.env.START_INDEX = START_INDEX;
process.env.HEADLESS = HEADLESS;
process.env.ALLOW_LIVE_RUN = ALLOW_LIVE_RUN;

function writeStatus(state, nextRunAt) {
  const status = {
    state,
    startIndex: parseInt(START_INDEX, 10) || 1,
    cooldownMinutes: COOLDOWN_MINUTES,
    group: GROUP,
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

function readLease() {
  if (!existsSync(LEASE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LEASE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeLease(owner, until) {
  writeFileSync(LEASE_FILE, JSON.stringify({ owner, until }));
}

// Group lease with preemption: the priority group (A = 1xbet shards) always
// takes the lease, even mid-run, so it never waits for B. The non-priority
// group (B = linebet/melbet) only runs when the lease is free (owner null or
// its own group) and stops its active run if the priority group takes over.
async function acquireGroupTurn() {
  while (true) {
    try {
      const lease = readLease();
      const now = Date.now();

      if (GROUP === PRIORITY_GROUP) {
        // Priority group preempts unconditionally.
        const prevOwner = lease?.owner;
        writeLease(GROUP, now + LEASE_MS);
        if (prevOwner && prevOwner !== GROUP) {
          console.log(`Group ${GROUP} preempting group ${prevOwner} lease`);
        }
        return;
      }

      // Non-priority group: run only when the lease is free or ours.
      // Free = no lease, or lease expired, or released (owner null) with buffer elapsed.
      const leaseFree = !lease || lease.until <= now;
      if (leaseFree || (lease && lease.owner === GROUP)) {
        writeLease(GROUP, now + LEASE_MS);
        return;
      }

      // Priority group holds it — wait until it releases.
      const waitMs = Math.max(1000, lease.until - now + 1000);
      console.log(`Group ${GROUP} waiting for group ${lease.owner ?? 'release'} lease (${Math.round(waitMs / 1000)}s)...`);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 30_000)));
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function releaseGroupTurn() {
  try {
    const lease = readLease();
    if (lease && lease.owner === GROUP) {
      // Let the other group start shortly after all sibling shards finish.
      writeLease(null, Date.now() + RELEASE_BUFFER_MS);
    }
  } catch {
    // ignore
  }
}

async function runScheduled() {
  return new Promise((resolve) => {
    process.env.RUN_STARTED_AT = String(Date.now());
    const child = spawn('node', ['scripts/scheduled-run.mjs'], {
      stdio: 'inherit',
      env: process.env,
      detached: true
    });

    let preempted = false;
    let notifyRunning = false;

    const heartbeat = LEASE_FILE
      ? setInterval(() => {
          try {
            const lease = readLease();
            if (!lease || lease.until <= Date.now() || lease.owner === null || lease.owner === GROUP) {
              // Still ours (sibling finished and released, or lease expired) — keep it.
              writeLease(GROUP, Date.now() + LEASE_MS);
            }
          } catch {
            // ignore
          }
        }, HEARTBEAT_MS)
      : null;

    const notifyTimer = NOTIFY_INTERVAL_MS > 0
      ? setInterval(() => {
          if (notifyRunning) return;
          notifyRunning = true;
          const notify = spawn('node', ['scripts/notify.js'], {
            stdio: 'inherit',
            env: process.env,
            detached: true
          });
          notify.on('exit', () => {
            notifyRunning = false;
          });
          notify.on('error', () => {
            notifyRunning = false;
          });
        }, NOTIFY_INTERVAL_MS)
      : null;

    const preemptCheck = LEASE_FILE && GROUP !== PRIORITY_GROUP
      ? setInterval(() => {
          try {
            const lease = readLease();
            if (lease && lease.owner === PRIORITY_GROUP) {
              preempted = true;
              console.log(`Group ${GROUP} preempted by group ${PRIORITY_GROUP} — stopping run`);
              try {
                process.kill(-child.pid, 'SIGTERM');
              } catch {
                child.kill('SIGTERM');
              }
            }
          } catch {
            // ignore
          }
        }, PREEMPT_CHECK_MS)
      : null;

    child.on('exit', (code) => {
      clearInterval(heartbeat);
      clearInterval(notifyTimer);
      clearInterval(preemptCheck);
      resolve({ ok: code === 0, preempted });
    });
    child.on('error', (error) => {
      clearInterval(heartbeat);
      clearInterval(notifyTimer);
      clearInterval(preemptCheck);
      console.error(`Failed to start scheduled-run.mjs: ${error.message}`);
      resolve({ ok: false, preempted });
    });
  });
}

let run = 0;

writeStatus('starting', null);

while (true) {
  run += 1;
  if (LEASE_FILE) {
    writeStatus('waiting', null);
    console.log(`[Run #${run}] Waiting for group turn...`);
    await acquireGroupTurn();
  }
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

  const { ok, preempted } = await runScheduled();
  console.log(ok ? `[Run #${run}] Done` : `[Run #${run}] Finished with errors`);

  if (LEASE_FILE) {
    releaseGroupTurn();
  }

  if (preempted) {
    // Priority group took over; don't cooldown, just wait for the next turn.
    console.log(`[Run #${run}] Preempted — going back to waiting`);
    continue;
  }

  const nextRunAt = new Date(Date.now() + COOLDOWN_MS).toISOString();
  writeStatus('cooldown', nextRunAt);
  console.log(`Cooling down ${COOLDOWN_MINUTES}min... (next run ${nextRunAt})`);
  await new Promise((r) => setTimeout(r, COOLDOWN_MS));
}
