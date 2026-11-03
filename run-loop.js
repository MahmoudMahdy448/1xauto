import { spawn } from 'child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { emit } from './lib/events.js';
import { readState } from './lib/state.js';
import { resumeStartIndex } from './lib/resume.js';
import {
  readGate,
  markProbeFailed,
  markReminderSent,
  reminderDue
} from './lib/deposit-gate.js';
import { sendGateAlert } from './lib/deposit-gate-notify.js';
import { blockDue, readSiteBlock } from './lib/site-block.js';

dotenv.config();

const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES, 10) || 10;
const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1000;
const START_INDEX = process.env.START_INDEX || '1';
// One-shot resume: the first pass continues at the account the saved state
// reached, later passes go back to the range start (START_INDEX).
const RESUME_FROM_STATE = process.env.RESUME_FROM_STATE === 'true';
const STATE_FILE = process.env.STATE_FILE ? path.resolve(process.cwd(), process.env.STATE_FILE) : null;
const HEADLESS = process.env.HEADED === 'true' ? 'false' : 'true';
const ALLOW_LIVE_RUN = 'true';
const STATUS_FILE = path.resolve(process.cwd(), process.env.STATUS_FILE || 'loop-status.json');
const GROUP = process.env.RUN_GROUP || 'A';
const LEASE_FILE = process.env.LEASE_FILE || null;
const LEASE_MS = 2 * 60 * 60 * 1000;
const HEARTBEAT_MS = 2 * 60 * 1000;
const PREEMPT_CHECK_MS = 15 * 1000;
const RELEASE_BUFFER_MS = 5 * 60 * 1000;
const PRIORITY_GROUP = process.env.PRIORITY_GROUP || 'A';
const NOTIFY_INTERVAL_MINUTES = process.env.NOTIFY_INTERVAL_MINUTES !== undefined
  ? parseInt(process.env.NOTIFY_INTERVAL_MINUTES, 10) || 0
  : (process.env.SKIP_NOTIFY === 'true' ? 0 : 15);
const NOTIFY_INTERVAL_MS = NOTIFY_INTERVAL_MINUTES * 60 * 1000;

// Deposit gate: while the wallet is disabled the loop sleeps instead of opening
// browsers, and runs a single-account probe on the ladder from
// lib/deposit-gate.js.
const GATE_ENABLED = process.env.GATE_ENABLED !== 'false';
const SERVICE_NAME = process.env.SERVICE_NAME || 'local';
const GATE_LOCK_FILE = path.resolve(
  process.cwd(),
  process.env.GATE_LOCK_FILE || 'deposit-gate.probe.lock'
);
const GATE_LOCK_STALE_MS = 10 * 60 * 1000;
const GATE_PROBE_INDICES = (() => {
  const suffix = String(process.env.SERVICE_NAME || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  const raw =
    (suffix && process.env[`GATE_PROBE_INDICES_${suffix}`]) ||
    process.env.GATE_PROBE_INDICES ||
    START_INDEX;
  const parsed = String(raw)
    .split(',')
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => Number.isInteger(v) && v > 0);
  return parsed.length ? parsed : [parseInt(START_INDEX, 10) || 1];
})();

process.env.START_INDEX = START_INDEX;
process.env.HEADLESS = HEADLESS;
process.env.ALLOW_LIVE_RUN = ALLOW_LIVE_RUN;

// Guard: this project must use the shared ledger that mirrors the Telegram
// channel. Old per-shard ledgers only know a slice of the history, so starting
// a loop with one re-sends numbers that were already delivered.
const ledgerFile = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json');
if (path.basename(ledgerFile) !== 'seen-numbers.json' && process.env.FORCE_ALT_LEDGER !== 'true') {
  console.error(`[run-loop] Refusing to start with ledger "${path.basename(ledgerFile)}".`);
  console.error('[run-loop] Start the shards with run-all-shards.ps1 (shared seen-numbers.json).');
  console.error('[run-loop] Set FORCE_ALT_LEDGER=true only if you really want a separate ledger.');
  process.exit(1);
}

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

async function runScheduled(run) {
  return new Promise((resolve) => {
    process.env.RUN_STARTED_AT = String(Date.now());
    const batchStartedAt = Date.now();
    emit({ kind: 'batch.start', data: { run, startIndex: parseInt(process.env.START_INDEX, 10) || 1 } });
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
      emit({
        kind: 'batch.end',
        data: { ok: code === 0, preempted, durationMs: Date.now() - batchStartedAt, run }
      });
      resolve({ ok: code === 0, preempted });
    });
    child.on('error', (error) => {
      clearInterval(heartbeat);
      clearInterval(notifyTimer);
      clearInterval(preemptCheck);
      console.error(`Failed to start scheduled-run.mjs: ${error.message}`);
      emit({
        kind: 'batch.end',
        data: { ok: false, preempted, durationMs: Date.now() - batchStartedAt, run, error: error.message }
      });
      resolve({ ok: false, preempted });
    });
  });
}

let run = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One shard probes at a time. A stale lock (process died mid-probe) is stolen
// after 10 minutes so a crash cannot freeze the gate forever.
function claimProbe() {
  const payload = JSON.stringify({ owner: SERVICE_NAME, at: new Date().toISOString() });
  try {
    writeFileSync(GATE_LOCK_FILE, payload, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.error(`[gate] could not claim the probe lock: ${error.message}`);
      return false;
    }
  }
  try {
    const ageMs = Date.now() - statSync(GATE_LOCK_FILE).mtimeMs;
    if (ageMs > GATE_LOCK_STALE_MS) {
      console.log('[gate] stealing a stale probe lock');
      rmSync(GATE_LOCK_FILE, { force: true });
      writeFileSync(GATE_LOCK_FILE, payload, { flag: 'wx' });
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function releaseProbe() {
  try {
    rmSync(GATE_LOCK_FILE, { force: true });
  } catch {
    // ignore
  }
}

// A probe is a normal one-account pass, so the realtime sender, the ledger and
// the screenshot naming all keep working. It differs in three ways: it does not
// move the shard's saved position, it does not retry, and it does not send a
// batch summary.
async function runProbePass(run, gate) {
  const index = GATE_PROBE_INDICES[(gate.probeCount || 0) % GATE_PROBE_INDICES.length];
  const saved = {
    start: process.env.START_INDEX,
    end: process.env.END_INDEX,
    skip: process.env.SKIP_NOTIFY,
    retries: process.env.MAX_RETRIES,
    probe: process.env.GATE_PROBE,
    summary: process.env.RUN_SUMMARY_FILE
  };

  process.env.START_INDEX = String(index);
  process.env.END_INDEX = String(index);
  process.env.SKIP_NOTIFY = 'true';
  process.env.MAX_RETRIES = '1';
  process.env.GATE_PROBE = 'true';
  // The spec always writes a run summary. Keep the shard's real summary (used
  // by the collector and the batch messages) out of a one-account probe.
  process.env.RUN_SUMMARY_FILE = path.resolve(process.cwd(), 'run-summary-gate-probe.json');

  console.log(`[gate] probing with account #${index}`);
  writeStatus('probing', null);

  try {
    await runScheduled(run);
  } finally {
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('START_INDEX', saved.start);
    restore('END_INDEX', saved.end);
    restore('SKIP_NOTIFY', saved.skip);
    restore('MAX_RETRIES', saved.retries);
    restore('GATE_PROBE', saved.probe);
    restore('RUN_SUMMARY_FILE', saved.summary);
    releaseProbe();
  }
}

async function handleGate(run, gate) {
  const dueMs = gate.nextCheckAt ? Date.parse(gate.nextCheckAt) : Date.now();
  const waitMs = Number.isFinite(dueMs) ? dueMs - Date.now() : 0;

  writeStatus('gated', gate.nextCheckAt || null);
  console.log(
    `[gate] vodafone deposit disabled since ${gate.since || 'unknown'} — ` +
      (waitMs > 0
        ? `next check ${gate.nextCheckAt} (${Math.round(waitMs / 60_000)} min)`
        : 'checking now')
  );

  if (waitMs > 0) await sleep(waitMs);

  // The other shard may have probed and cleared it while we slept.
  const fresh = readGate();
  if (!fresh.disabled) {
    console.log('[gate] cleared while waiting — resuming');
    return;
  }

  // Another shard probed while we slept and pushed the check forward; do not
  // spend a second probe now.
  const freshDue = fresh.nextCheckAt ? Date.parse(fresh.nextCheckAt) : 0;
  if (freshDue > Date.now() + 60_000) {
    console.log(`[gate] another shard checked — next ${fresh.nextCheckAt}`);
    return;
  }

  if (!claimProbe()) {
    console.log('[gate] another shard is probing — waiting 2 min');
    await sleep(2 * 60_000);
    return;
  }

  const before = fresh;
  await runProbePass(run, before);

  const after = readGate();
  if (!after.disabled) {
    console.log('[gate] vodafone is back — resuming full passes');
    return;
  }

  // markStillDisabled stamps lastCheckedAt. If it did not move, the probe never
  // reached the payment modal, so this is a probe problem, not the wallet.
  const sawRestriction = after.lastCheckedAt && after.lastCheckedAt !== before.lastCheckedAt;

  if (sawRestriction) {
    console.log(`[gate] still disabled — next check ${after.nextCheckAt}`);
    // The per-probe heartbeat is sent by the probe itself (raisePaymentGate in
    // tests/login.spec.js) so it takes effect without restarting the loop.
    // Here we only own the 60-minute reminder.
    if (reminderDue(after)) {
      try {
        await sendGateAlert({
          kind: 'reminder',
          gate: after,
          images: (after.screenshots || []).slice(0, 1)
        });
        markReminderSent();
      } catch (error) {
        console.error(`[gate] reminder failed: ${error.message}`);
      }
    }
    return;
  }

  const failed = markProbeFailed({ error: 'probe ended without a number or the restriction message' });
  console.warn(`[gate] probe failed (${failed.gate.probeFailures} in a row)`);
  if (failed.shouldAlertProbeBroken) {
    try {
      await sendGateAlert({ kind: 'probe-broken', gate: failed.gate });
    } catch (error) {
      console.error(`[gate] probe-broken alert failed: ${error.message}`);
    }
  }
}

writeStatus('starting', null);

// Continue where the last pass stopped, then go back to the range start for
// every later pass. Only the first pass uses the resumed index.
let resumeStart = null;
if (RESUME_FROM_STATE && STATE_FILE) {
  const saved = readState(STATE_FILE);
  const resumed = resumeStartIndex(saved, START_INDEX, process.env.END_INDEX);
  if (resumed > (parseInt(START_INDEX, 10) || 1)) {
    resumeStart = String(resumed);
    process.env.START_INDEX = resumeStart;
    console.log(`[run-loop] resuming at account #${resumeStart} (state lastProcessedIndex=${saved.lastProcessedIndex})`);
  }
}

while (true) {
  // IP-level block first: it is site-wide, so nothing at all may run, not even
  // a Vodafone probe. Re-read once a minute so a manual clear is noticed.
  const siteBlock = readSiteBlock();
  if (siteBlock.blocked && !blockDue(siteBlock)) {
    const waitMs = Math.max(0, Date.parse(siteBlock.blockedUntil) - Date.now());
    writeStatus('blocked', siteBlock.blockedUntil);
    console.log(
      `[block] 1xbet is blocking this IP — parked ${Math.round(waitMs / 60_000)} min ` +
        `(retry ${siteBlock.blockedUntil}, block #${siteBlock.blockCount || 1})`
    );
    await sleep(Math.min(waitMs, 60_000));
    continue;
  }

  // Nothing worth opening a browser for while the wallet is off. This also
  // covers a shard that restarted during an outage: it parks instead of
  // burning one login per account to rediscover the same modal.
  if (GATE_ENABLED) {
    const gate = readGate();
    if (gate.disabled) {
      // A failure in the gate itself (disk, spawn) must not kill the loop; a
      // short sleep keeps a broken gate from spinning.
      try {
        await handleGate(run, gate);
      } catch (error) {
        console.error(`[gate] handler failed: ${error.message} — retrying in 5 min`);
        await sleep(5 * 60_000);
      }
      continue;
    }
  }

  run += 1;
  if (LEASE_FILE) {
    writeStatus('waiting', null);
    console.log(`[Run #${run}] Waiting for group turn...`);
    await acquireGroupTurn();
  }
  console.log(`[Run #${run}] Starting from index ${process.env.START_INDEX}...`);

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

  const { ok, preempted } = await runScheduled(run);
  console.log(ok ? `[Run #${run}] Done` : `[Run #${run}] Finished with errors`);

  if (resumeStart) {
    // The resumed pass is over; later passes start from the shard's own range.
    process.env.START_INDEX = START_INDEX;
    resumeStart = null;
  }

  if (LEASE_FILE) {
    releaseGroupTurn();
  }

  if (preempted) {
    // Priority group took over; don't cooldown, just wait for the next turn.
    console.log(`[Run #${run}] Preempted — going back to waiting`);
    continue;
  }

  // The pass stopped because the wallet went away mid-run. Release the turn
  // and go straight back to the gate: the ladder decides when to look again,
  // the 90-minute cooldown would only delay the recovery check.
  if (GATE_ENABLED && readGate().disabled) {
    console.log(`[Run #${run}] Stopped by the deposit gate — waiting for the next check`);
    continue;
  }

  const nextRunAt = new Date(Date.now() + COOLDOWN_MS).toISOString();
  writeStatus('cooldown', nextRunAt);
  emit({ kind: 'cooldown.start', data: { minutes: COOLDOWN_MINUTES, nextRunAt } });
  console.log(`Cooling down ${COOLDOWN_MINUTES}min... (next run ${nextRunAt})`);
  await new Promise((r) => setTimeout(r, COOLDOWN_MS));
  emit({ kind: 'cooldown.end', data: { run } });
}
