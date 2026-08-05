#!/usr/bin/env node
// Combined collector for a sharded VM.
//
// The new VM runs N shards of the same site (e.g. 3-4 1xauto shards). Each
// shard runs run-loop.js with SKIP_NOTIFY=true and NOTIFY_INTERVAL_MINUTES=0 so
// it never sends Telegram messages on its own. This collector:
//
//   1. polls every shard's loop-status file (STATUS_FILE / loop-status-shard-N.json),
//   2. waits until EVERY shard has finished its run since the last collection,
//   3. runs one combined `scripts/notify.js` against the SHARED ledger with
//      SCREENSHOTS_DIRS pointing at every shard's screenshots dir, so a single
//      message carries the unique numbers of the whole run cycle,
//   4. records the collection so the next cycle is only sent once all shards
//      finish again.
//
// The ledger (SEEN_NUMBERS_FILE) guarantees global dedup across shards, so
// notify only sends numbers that have never been sent before.
//
// Env:
//   COLLECTOR_STATUS_FILES  comma-separated loop-status file paths (required)
//   SCREENSHOTS_DIRS        comma-separated shard screenshots dirs (required)
//   COLLECT_STATE_FILE      where last-collection state is kept (default collect-state.json)
//   POLL_MS                 poll interval (default 30000)
//   (plus the usual TELEGRAM_*, SEEN_NUMBERS_FILE/LOCK, EXCEL_COMBINED_FILE/UNIQUE_FILE)
//
// CLI:
//   node scripts/collector.mjs --once      single poll pass, then exit
//   node scripts/collector.mjs --force     collect immediately (test), then exit
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const statusFiles = (process.env.COLLECTOR_STATUS_FILES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => path.resolve(process.cwd(), s));
const screenshotsDirs = (process.env.SCREENSHOTS_DIRS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => path.resolve(process.cwd(), s));
const stateFile = path.resolve(process.cwd(), process.env.COLLECT_STATE_FILE || 'collect-state.json');
const POLL_MS = parseInt(process.env.POLL_MS, 10) || 30_000;

const once = process.argv.includes('--once');
const force = process.argv.includes('--force');

if (statusFiles.length === 0) {
  console.error('COLLECTOR_STATUS_FILES required (comma-separated loop-status file paths).');
  process.exit(1);
}
if (screenshotsDirs.length === 0) {
  console.error('SCREENSHOTS_DIRS required (comma-separated shard screenshots dirs).');
  process.exit(1);
}

function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadState() {
  const st = readJson(stateFile) || {};
  if (!st || typeof st.lastCollectedAt !== 'number') {
    // First start: seed so a run already in progress is not counted as done.
    const statuses = statusFiles.map((f) => readJson(f));
    return {
      lastCollectedAt: Date.now(),
      lastRun: statuses.map((s) => (s && typeof s.run === 'number' ? s.run : 0))
    };
  }
  return {
    lastCollectedAt: st.lastCollectedAt,
    lastRun: Array.isArray(st.lastRun) ? st.lastRun : statusFiles.map(() => 0)
  };
}

function saveState(st) {
  writeFileSync(stateFile, JSON.stringify(st, null, 2));
}

function statusTimeMs(status) {
  const t = status && status.updatedAt ? Date.parse(status.updatedAt) : NaN;
  return Number.isFinite(t) ? t : 0;
}

// A shard has finished a run since the last collection when it is in cooldown
// (run done, waiting for next) written after lastCollectedAt, or it already
// advanced to a newer run than the one we collected. The second clause keeps
// working across shard restarts where the run counter resets.
function shardDone(status, idx, st) {
  if (!status) return false;
  const cooldownAfterCollect = status.state === 'cooldown' && statusTimeMs(status) > st.lastCollectedAt;
  const advancedRun = status.state === 'running' && (status.run || 0) > (st.lastRun[idx] || 0);
  return cooldownAfterCollect || advancedRun;
}

function allDone(statuses, st) {
  if (statuses.some((s) => !s)) {
    return { ready: false, reason: 'missing status file(s)' };
  }
  const done = statuses.map((s, i) => shardDone(s, i, st));
  if (done.every(Boolean)) {
    return { ready: true, reason: null };
  }
  const waiting = statuses.map((s) => `${s.state}@${s.run ?? 0}`).join(', ');
  return { ready: false, reason: `not all shards finished (${waiting})` };
}

function runCombinedNotify() {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/notify.js'], {
      stdio: 'inherit',
      env: process.env,
      detached: true
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', (error) => {
      console.error(`collector: failed to start notify.js: ${error.message}`);
      resolve(false);
    });
  });
}

async function collectOnce() {
  const st = loadState();
  const statuses = statusFiles.map((f) => readJson(f));
  const { ready, reason } = allDone(statuses, st);

  if (force) {
    console.log('collector: --force — collecting immediately.');
  } else if (!ready) {
    console.log(`collector: ${reason} — waiting for all shards to finish a run.`);
    return;
  } else {
    console.log('collector: all shards finished a run — collecting combined unique numbers.');
  }

  const ok = await runCombinedNotify();
  if (!ok) {
    console.error('collector: combined notify failed — will retry on next poll.');
    return;
  }

  st.lastCollectedAt = Date.now();
  st.lastRun = statuses.map((s, i) => (s && typeof s.run === 'number' ? s.run : (st.lastRun[i] || 0)));
  saveState(st);
  console.log('collector: collection done.');
}

if (once || force) {
  collectOnce().then(() => process.exit(0));
} else {
  collectOnce();
  setInterval(collectOnce, POLL_MS);
  console.log(`collector: polling ${statusFiles.length} shard status file(s) every ${POLL_MS}ms.`);
}
