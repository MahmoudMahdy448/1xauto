// demo-watch.mjs
// Read-only control-room server for the boss demo.
//
//   node scripts/demo-watch.mjs --service shard-2 --port 8787 --open
//   node scripts/demo-watch.mjs --service demo --port 8787 --open
//   node scripts/demo-watch.mjs --service all --port 8787 --open
//
// `all` is the fleet view: 1xbet shard 1 + shard 2 + melbet, plus CPU/RAM and
// browser-process counters, and a measured 1-shard vs 3-shard throughput
// comparison. FLEET_SERVICES overrides the list (demo uses demo-s1,demo-s2).
//
// It serves demo/dashboard.html (one service) or demo/fleet.html (all) and one
// JSON snapshot of what the real pipeline is doing. Nothing here writes to the
// farm. Bind is 127.0.0.1 only: this is an operations screen, not a public
// dashboard.

import { createServer } from 'http';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const root = process.cwd();
const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

const service = arg('service', process.env.DEMO_SERVICE || 'shard-2');
const isDemo = service === 'demo';
const fleetMode = service === 'all';
const requestedPort = parseInt(arg('port', process.env.DEMO_PORT || '8787'), 10);
const shouldOpen = process.argv.includes('--open');

const melbetRoot = path.resolve(
  root,
  process.env.MELBET_ROOT || path.join('..', 'melbet-autologin')
);
const fleetIds = (process.env.FLEET_SERVICES || 'shard-1,shard-2,melbet')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
// The demo runner stamps the moment the fleet started so melbet screenshots
// from an earlier pass are not counted as this run's output.
const fleetStartAt = process.env.FLEET_START_AT ? Date.parse(process.env.FLEET_START_AT) : null;
// Remember the rate measured while a single shard ran alone. The fleet demo
// starts one shard first, then adds the other two, so the comparison is a real
// 1-shard measurement and not just an average of the three.
let soloRate = null;

function fleetLabel(id) {
  const match = id.match(/^(?:demo-s|shard-)(\d+)$/);
  if (match) return `1xbet · shard ${match[1]}`;
  if (id === 'melbet') return 'melbet · shard 1';
  return id;
}

function servicePaths(id) {
  if (id === 'melbet') {
    return {
      id,
      label: fleetLabel(id),
      root: melbetRoot,
      status: path.join(melbetRoot, 'loop-status.json'),
      state: null,
      summary: null,
      shots: path.join(melbetRoot, 'screenshots'),
      log: path.resolve(melbetRoot, process.env.MELBET_LOG || 'logs/run-out.log'),
      eventsPrefix: null,
      ledger: path.join(melbetRoot, 'seen-numbers.json')
    };
  }
  return {
    id,
    label: fleetLabel(id),
    root,
    status: path.join(root, `loop-status-${id}.json`),
    state: path.join(root, `state-${id}.json`),
    summary: path.join(root, `run-summary-${id}.json`),
    shots: path.join(root, 'screenshots', id),
    log: path.join(root, 'logs', `${id}.log`),
    eventsPrefix: id,
    ledger: path.resolve(root, process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json')
  };
}

const paths = {
  status: path.join(root, `loop-status-${service}.json`),
  state: path.join(root, `state-${service}.json`),
  summary: path.join(root, `run-summary-${service}.json`),
  shots: path.join(root, 'screenshots', service),
  log: path.join(root, 'logs', `${service}.log`),
  events: path.resolve(root, process.env.EVENTS_DIR || 'events'),
  ledger: path.resolve(root, process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json'),
  block: path.resolve(root, process.env.SITE_BLOCK_FILE || 'site-block.json'),
  gate: path.resolve(root, process.env.GATE_FILE || 'deposit-gate.json'),
  dashboard: path.join(here, '..', 'demo', 'dashboard.html'),
  fleet: path.join(here, '..', 'demo', 'fleet.html')
};

const demoTotal = (() => {
  const raw = process.env.DEMO_INDICES;
  if (!raw) return 3;
  const count = raw.split(',').map((v) => v.trim()).filter(Boolean).length;
  return count || 3;
})();

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readTail(file, bytes = 96 * 1024) {
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const fd = readFileSync(file);
    return fd.subarray(start).toString('utf8');
  } catch {
    return '';
  }
}

function tailLines(file, count) {
  return readTail(file)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-count);
}

const ledgerCache = { mtimeMs: 0, value: { total: 0, last: [] } };
function readLedger() {
  try {
    const info = statSync(paths.ledger);
    if (info.mtimeMs === ledgerCache.mtimeMs) return ledgerCache.value;
    const parsed = readJson(paths.ledger);
    const numbers = Array.isArray(parsed?.numbers) ? parsed.numbers : [];
    ledgerCache.value = {
      total: numbers.length,
      last: numbers.slice(-5).reverse(),
      updatedAt: parsed?.updatedAt || null
    };
    ledgerCache.mtimeMs = info.mtimeMs;
    return ledgerCache.value;
  } catch {
    return ledgerCache.value;
  }
}

function listEventFiles(prefix = service) {
  try {
    return readdirSync(paths.events)
      .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.jsonl'))
      .map((name) => path.join(paths.events, name))
      .sort();
  } catch {
    return [];
  }
}

function readEvents(limit = 90, prefix = service) {
  const out = [];
  for (const file of listEventFiles(prefix)) {
    const text = readTail(file);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && event.ts) out.push(event);
      } catch {
        // a half-written last line is normal; skip it
      }
    }
  }
  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return out.slice(-limit);
}

function listShots(limit = 12) {
  try {
    return readdirSync(paths.shots)
      .filter((name) => name.toLowerCase().endsWith('.png'))
      .map((name) => {
        const full = path.join(paths.shots, name);
        const info = statSync(full);
        const number = (name.match(/01\d{9}/) || [])[0] || null;
        return { file: name, at: info.mtime.toISOString(), mtimeMs: info.mtimeMs, number };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function shotsTotal() {
  try {
    return readdirSync(paths.shots).filter((name) => name.toLowerCase().endsWith('.png')).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// fleet readers
// ---------------------------------------------------------------------------

function shotsInDir(dir, sinceMs, limit = 12) {
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.png'))
      .map((name) => {
        const full = path.join(dir, name);
        const info = statSync(full);
        return {
          file: name,
          at: info.mtime.toISOString(),
          mtimeMs: info.mtimeMs,
          number: (name.match(/01\d{9}/) || [])[0] || null
        };
      })
      .filter((shot) => !sinceMs || shot.mtimeMs >= sinceMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function countShotsInDir(dir, sinceMs) {
  try {
    return readdirSync(dir).filter((name) => {
      if (!name.toLowerCase().endsWith('.png')) return false;
      if (!sinceMs) return true;
      try {
        return statSync(path.join(dir, name)).mtimeMs >= sinceMs;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

const ledgerCacheByFile = new Map();
function ledgerAt(file) {
  try {
    const info = statSync(file);
    const cached = ledgerCacheByFile.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs) return cached.value;
    const parsed = readJson(file);
    const numbers = Array.isArray(parsed?.numbers) ? parsed.numbers : [];
    const value = { total: numbers.length, updatedAt: parsed?.updatedAt || null };
    ledgerCacheByFile.set(file, { mtimeMs: info.mtimeMs, value });
    return value;
  } catch {
    return { total: 0, updatedAt: null };
  }
}

// Accounts per hour from completion timestamps. With one completion, the rate
// is one per elapsed time (minimum 30 s), so the first minute is not nonsense.
function rateFromTimes(times) {
  const now = Date.now();
  const floor = now - 15 * 60_000;
  const window = times.filter((time) => Number.isFinite(time) && time >= floor).sort((a, b) => a - b);
  if (!window.length) return null;
  if (window.length === 1) {
    const minutes = Math.max(0.5, (now - window[0]) / 60_000);
    return Math.round(60 / minutes);
  }
  const span = Math.max(0.5, (window[window.length - 1] - window[0]) / 60_000);
  return Math.round(((window.length - 1) / span) * 60);
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// Melbet's spec writes plain Playwright output, not pipeline events. Read the
// account it is on and how many accounts this run was asked to do.
function parseMelbetLog(file) {
  const lines = tailLines(file, 400);
  let current = null;
  let total = null;
  let loaded = null;
  for (const line of lines) {
    let match = line.match(/Loaded (\d+) account/);
    if (match) loaded = Number(match[1]);
    match = line.match(/#(\d+) through #(\d+) \((\d+) total\)/);
    if (match) total = Number(match[3]);
    match = line.match(/\[(\d+)\/(\d+)\] Signing in with ([\w.@+-]+)/);
    if (match) {
      current = {
        account: match[3],
        index: Number(match[1]),
        phase: 'login',
        stepLabel: 'signing in',
        result: null
      };
    }
    if (/Screenshot saved to/.test(line) && current) {
      current.phase = 'payment';
      current.stepLabel = 'number extracted';
      current.result = 'ok';
    }
    match = line.match(/Failed for ([\w.@+-]+)/);
    if (match) {
      current = {
        account: match[1],
        phase: 'account',
        stepLabel: 'account failed',
        result: 'failed'
      };
    }
  }
  return { current, total, loaded };
}

// ---------------------------------------------------------------------------
// system metrics
// ---------------------------------------------------------------------------

let cpuTimes = os.cpus().map((cpu) => cpu.times);
function cpuPercent() {
  const now = os.cpus().map((cpu) => cpu.times);
  let idle = 0;
  let total = 0;
  for (let i = 0; i < now.length; i += 1) {
    const before = cpuTimes[i];
    const after = now[i];
    if (!before || !after) continue;
    const idleDelta = after.idle - before.idle;
    const totalDelta =
      after.user - before.user +
      after.nice - before.nice +
      after.sys - before.sys +
      after.irq - before.irq +
      idleDelta;
    idle += Math.max(0, idleDelta);
    total += Math.max(0, totalDelta);
  }
  cpuTimes = now;
  return total ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}

const processCache = {
  at: 0,
  busy: false,
  value: {
    browsers: { count: 0, mb: 0 },
    node: { count: 0, mb: 0 }
  }
};

function refreshProcessStats() {
  if (process.platform !== 'win32') return;
  if (processCache.busy || Date.now() - processCache.at < 2500) return;
  processCache.busy = true;
  const pwsh = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const command =
    "Get-Process chrome,chrome-headless-shell,node -ErrorAction SilentlyContinue | " +
    "Group-Object ProcessName | ForEach-Object { '{0}|{1}|{2}' -f $_.Name,$_.Count,[long](($_.Group | Measure-Object WorkingSet64 -Sum).Sum) }";
  let output = '';
  const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-Command', command]);
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  const finish = () => {
    const value = {
      browsers: { count: 0, mb: 0 },
      node: { count: 0, mb: 0 }
    };
    for (const line of output.split(/\r?\n/)) {
      const [name, count, bytes] = line.trim().split('|');
      if (!name || !count || !bytes) continue;
      const entry = { count: Number(count) || 0, mb: Math.round((Number(bytes) || 0) / 1024 / 1024) };
      if (name === 'node') value.node = entry;
      else if (name.startsWith('chrome')) {
        value.browsers.count += entry.count;
        value.browsers.mb += entry.mb;
      }
    }
    processCache.value = value;
    processCache.at = Date.now();
    processCache.busy = false;
  };
  child.on('close', finish);
  child.on('error', () => {
    processCache.busy = false;
  });
}

function systemSnapshot() {
  refreshProcessStats();
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  return {
    cpuPercent: cpuPercent(),
    memUsedMb: totalMb - freeMb,
    memTotalMb: totalMb,
    memPercent: Math.round(((totalMb - freeMb) / totalMb) * 1000) / 10,
    cores: os.cpus().length,
    browsers: processCache.value.browsers,
    node: processCache.value.node,
    sampledAt: new Date(processCache.at || Date.now()).toISOString()
  };
}

// ---------------------------------------------------------------------------
// fleet snapshot
// ---------------------------------------------------------------------------

function safetySnapshot() {
  const block = readJson(paths.block);
  const gate = readJson(paths.gate);
  return {
    block: {
      blocked: !!block?.blocked,
      until: block?.blockedUntil || null,
      minutesLeft: block?.blocked ? minutesUntil(block.blockedUntil) : null,
      reason: block?.reason || null,
      count: block?.blockCount || 0,
      recoveredAt: block?.recoveredAt || null
    },
    gate: {
      disabled: !!gate?.disabled,
      reason: gate?.reason || null,
      nextCheckAt: gate?.nextCheckAt || null,
      minutesToCheck: gate?.disabled ? minutesUntil(gate.nextCheckAt) : null,
      probeCount: gate?.probeCount || 0,
      restoredAt: gate?.restoredAt || null
    }
  };
}

function serviceSnapshot(sp) {
  const status = readJson(sp.status);
  const state = sp.state ? readJson(sp.state) : null;
  const summary = sp.summary ? readJson(sp.summary) : null;

  let statusFresh = false;
  try {
    statusFresh = Date.now() - statSync(sp.status).mtimeMs < 10 * 60_000;
  } catch {
    statusFresh = false;
  }
  const effectiveStatus = status && (statusFresh || status.state === 'running') ? status : null;

  const events = sp.eventsPrefix ? readEvents(600, sp.eventsPrefix) : [];
  const batched = events.filter((event) => event.batch);
  const batchId = batched.length ? batched[batched.length - 1].batch : state?.batchId || null;
  const batchEvents = batchId ? events.filter((event) => event.batch === batchId) : events;
  const done = batchEvents.filter((event) => event.kind === 'account.done');
  const failed = batchEvents.filter((event) => event.kind === 'account.failed');

  // The sender does not stamp the batch id, so count only what it did inside
  // this batch's time window. Otherwise "already seen" includes yesterday.
  const batchStartMs = Number.isFinite(Date.parse(state?.batchId))
    ? Date.parse(state.batchId)
    : fleetStartAt || 0;
  const senderEvents = events.filter(
    (event) => event.role === 'sender' && Date.parse(event.ts) >= batchStartMs
  );
  const sent = senderEvents.filter((event) => event.kind === 'send.ok');
  const skipped = senderEvents.filter((event) => event.kind === 'send.skip');

  // Count every unique number in the batch, then keep only the newest 6 for
  // thumbnails. The count must not be capped by how many cards fit on screen.
  const batchNumbers = new Set();
  for (const event of batchEvents) {
    if (event.kind === 'step' && event.step === 'shot.saved' && event.data?.number) {
      batchNumbers.add(event.data.number);
    }
  }

  const numbers = [];
  const seen = new Set();
  for (const event of [...batchEvents].reverse()) {
    if (event.kind !== 'step' || event.step !== 'shot.saved') continue;
    const number = event.data?.number;
    if (!number || seen.has(number)) continue;
    seen.add(number);
    const file = event.data?.shot ? path.basename(event.data.shot) : null;
    numbers.push({
      number,
      at: event.ts,
      file,
      url: file ? `/shots/${encodeURIComponent(sp.id)}/${encodeURIComponent(file)}` : null
    });
    if (numbers.length >= 6) break;
  }

  const withAccount = events.filter((event) => event.account);
  const last = withAccount[withAccount.length - 1] || null;
  let current = null;
  if (last) {
    const firstForAccount = withAccount.find((event) => event.account === last.account) || last;
    const finished = last.kind === 'account.done' || last.kind === 'account.failed';
    current = {
      account: last.account,
      phase: last.phase || '',
      step: last.step || last.kind,
      stepLabel: stepLabel(last.step || last.kind),
      elapsedMs: Math.max(
        0,
        (finished ? Date.parse(last.ts) : Date.now()) - Date.parse(firstForAccount.ts)
      ),
      result: last.kind === 'account.done' ? 'ok' : last.kind === 'account.failed' ? 'failed' : null
    };
  }

  const isMelbet = sp.id === 'melbet';
  const sinceMs = fleetStartAt || Date.now() - 2 * 60 * 60_000;
  const recentShots = shotsInDir(sp.shots, isMelbet ? sinceMs : null, 6);
  let melbet = null;
  if (isMelbet) {
    melbet = parseMelbetLog(sp.log);
    current = melbet.current;
    // Melbet writes screenshots, not pipeline events, so its numbers come
    // from the files created during this window.
    numbers.length = 0;
    for (const shot of recentShots) {
      if (!shot.number || numbers.some((item) => item.number === shot.number)) continue;
      numbers.push({
        number: shot.number,
        at: shot.at,
        file: shot.file,
        url: `/shots/melbet/${encodeURIComponent(shot.file)}`
      });
    }
  }

  const processed = isMelbet ? recentShots.length : done.length + failed.length;
  const rangeStart = parseInt(status?.startIndex, 10) || 1;
  const rangeEnd =
    parseInt(summary?.endIndex, 10) || parseInt(state?.totalAccounts, 10) || 276;
  // Same batch math as the single-shard view: a resumed pass shows the accounts
  // it has left, not the whole shard range.
  const batchStart = Math.max(
    rangeStart,
    (Number.isFinite(state?.lastProcessedIndex) ? state.lastProcessedIndex : rangeStart) - processed + 1
  );
  const total = isMelbet
    ? melbet?.total || null
    : status?.demoTotal || Math.max(1, rangeEnd - batchStart + 1);
  const okCount = isMelbet ? processed : done.length;
  const failedCount = isMelbet ? 0 : failed.length;
  const msValues = done.map((event) => Number(event.data?.ms)).filter((value) => Number.isFinite(value));
  const rateTimes = isMelbet
    ? recentShots.map((shot) => shot.mtimeMs)
    : [...done, ...failed].map((event) => Date.parse(event.ts));
  const ratePerHour = rateFromTimes(rateTimes);

  let lastActivityAt = null;
  if (isMelbet) {
    try {
      lastActivityAt = statSync(sp.log).mtime.toISOString();
    } catch {
      lastActivityAt = null;
    }
  } else if (events.length) {
    lastActivityAt = events[events.length - 1].ts;
  }
  const freshActivity = lastActivityAt && Date.now() - Date.parse(lastActivityAt) < 90_000;
  const running =
    effectiveStatus?.state === 'running' ||
    (!!effectiveStatus && effectiveStatus.state === 'starting') ||
    !!freshActivity;
  // An idle shard keeps its last batch in JSON/events. Showing that as the
  // current account would be a lie, so a shard with no activity for 10 minutes
  // is rendered as idle with zeroed counters.
  const stale = !running && (!lastActivityAt || Date.now() - Date.parse(lastActivityAt) > 10 * 60_000);

  if (stale) {
    current = null;
    numbers.length = 0;
  }

  return {
    id: sp.id,
    label: sp.label,
    running,
    stale,
    status: effectiveStatus
      ? { state: effectiveStatus.state, nextRunAt: effectiveStatus.nextRunAt || null, run: effectiveStatus.run || null }
      : null,
    current,
    progress: {
      processed: stale ? 0 : processed,
      total: stale ? null : total || processed,
      percent:
        !stale && total && total > 0
          ? Math.min(100, Math.round((processed / total) * 1000) / 10)
          : null,
      demoIndices: effectiveStatus?.demoIndices || null
    },
    batch: {
      ok: stale ? 0 : okCount,
      failed: stale ? 0 : failedCount,
      numbers: stale ? 0 : isMelbet ? numbers.length : batchNumbers.size,
      sent: stale ? 0 : sent.length,
      skipped: stale ? 0 : skipped.length,
      avgMs: stale || !msValues.length
        ? null
        : Math.round(msValues.reduce((a, b) => a + b, 0) / msValues.length)
    },
    ratePerHour: stale ? null : ratePerHour,
    numbers,
    lastActivityAt,
    ledger: ledgerAt(sp.ledger),
    _events: stale ? [] : events
  };
}

function fleetSnapshot() {
  refreshProcessStats();
  const services = fleetIds.map((id) => serviceSnapshot(servicePaths(id)));
  const cutoff = Date.now() - 15 * 60_000;
  const events = services
    .flatMap((item) => item._events)
    .filter((event) => Date.parse(event.ts) >= cutoff)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .slice(-90);

  const running = services.filter((service) => service.running);
  const rates = running.map((service) => service.ratePerHour).filter((value) => value > 0);
  const fleetRate = rates.length ? rates.reduce((a, b) => a + b, 0) : null;
  const perShardRate = median(rates);
  const activeShards = running.length;
  if (activeShards === 1 && rates.length === 1) {
    soloRate = rates[0];
  }
  const baselineRate = soloRate || perShardRate;

  const totals = services.reduce(
    (sum, service) => {
      sum.processed += service.progress.processed;
      sum.numbers += service.batch.numbers;
      sum.sent += service.batch.sent;
      sum.skipped += service.batch.skipped;
      sum.failed += service.batch.failed;
      return sum;
    },
    { processed: 0, numbers: 0, sent: 0, skipped: 0, failed: 0 }
  );

  return {
    generatedAt: new Date().toISOString(),
    service: 'all',
    mode: 'fleet',
    server: { startedAt: serverStartedAt, port: activePort },
    services: services.map(({ _events, ...rest }) => rest),
    totals: {
      ...totals,
      activeShards,
      shardCount: services.length,
      ratePerHour: fleetRate
    },
    comparison: {
      oneShardRate: baselineRate,
      medianShardRate: perShardRate,
      soloMeasured: soloRate !== null,
      fleetRate,
      activeShards,
      measuredShards: rates.length,
      warming: activeShards >= 2 && rates.length < activeShards,
      multiplier:
        baselineRate && fleetRate
          ? Math.round((fleetRate / baselineRate) * 10) / 10
          : null
    },
    system: systemSnapshot(),
    safety: safetySnapshot(),
    events: events.map((event) => ({
      ts: event.ts,
      svc: event.svc || null,
      kind: event.kind,
      step: event.step || null,
      account: event.account || null,
      phase: event.phase || null,
      role: event.role || null,
      data: event.data || null
    })),
    numbers: services
      .flatMap((service) => service.numbers.map((number) => ({ ...number, shard: service.label })))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 12)
  };
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

const STEP_LABELS = {
  'login.page_open': 'opening login page',
  'login.filled': 'typing credentials',
  'login.submit': 'submitting login',
  'login.wait': 'waiting for the site',
  'payment.open': 'opening wallet',
  'payment.read_number': 'reading Vodafone number',
  'shot.saved': 'saving evidence',
  'account.done': 'account complete',
  'account.failed': 'account failed'
};

function stepLabel(step) {
  if (!step) return '';
  return STEP_LABELS[step] || String(step).replace(/[._]/g, ' ');
}

function minutesUntil(iso) {
  if (!iso) return null;
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
}

function snapshot() {
  const status = readJson(paths.status);
  const state = readJson(paths.state);
  const summary = readJson(paths.summary);
  const block = readJson(paths.block);
  const gate = readJson(paths.gate);
  const events = readEvents();
  const log = tailLines(paths.log, 90);
  const shots = listShots();
  const ledger = readLedger();

  const batched = events.filter((event) => event.batch);
  const batchId = batched.length ? batched[batched.length - 1].batch : state?.batchId || null;
  const batchEvents = batchId ? events.filter((event) => event.batch === batchId) : events;
  const done = batchEvents.filter((event) => event.kind === 'account.done');
  const failed = batchEvents.filter((event) => event.kind === 'account.failed');

  // The sender is a separate process and does not stamp the batch id, so count
  // its events from the same rolling window. "Extracted" is not "sent": a
  // number already in the ledger is skipped, and the boss should see that.
  const senderEvents = events.filter((event) => event.role === 'sender');
  const sent = senderEvents.filter((event) => event.kind === 'send.ok');
  const skipped = senderEvents.filter((event) => event.kind === 'send.skip');
  const sendFailed = senderEvents.filter((event) => event.kind === 'send.failed');

  const batchNumbers = new Set();
  for (const event of batchEvents) {
    if (event.kind === 'step' && event.step === 'shot.saved' && event.data?.number) {
      batchNumbers.add(event.data.number);
    }
  }

  const numbers = [];
  const seen = new Set();
  for (const event of [...batchEvents].reverse()) {
    if (event.kind !== 'step' || event.step !== 'shot.saved') continue;
    const number = event.data?.number;
    if (!number || seen.has(number)) continue;
    seen.add(number);
    const file = event.data?.shot ? path.basename(event.data.shot) : null;
    numbers.push({
      number,
      at: event.ts,
      file,
      url: file ? `/shots/${encodeURIComponent(file)}` : null
    });
    if (numbers.length >= 12) break;
  }

  const withAccount = events.filter((event) => event.account);
  const last = withAccount[withAccount.length - 1] || null;
  let current = null;
  if (last) {
    const firstForAccount = withAccount.find((event) => event.account === last.account) || last;
    const finished = last.kind === 'account.done' || last.kind === 'account.failed';
    current = {
      account: last.account,
      phase: last.phase || '',
      step: last.step || last.kind,
      stepLabel: stepLabel(last.step || last.kind),
      since: firstForAccount.ts,
      lastAt: last.ts,
      elapsedMs: Math.max(
        0,
        (finished ? Date.parse(last.ts) : Date.now()) - Date.parse(firstForAccount.ts)
      ),
      result: last.kind === 'account.done' ? 'ok' : last.kind === 'account.failed' ? 'failed' : null
    };
  }

  const rangeStart = parseInt(status?.startIndex, 10) || parseInt(summary?.startIndex, 10) || 1;
  const rangeEnd = parseInt(summary?.endIndex, 10) || parseInt(state?.totalAccounts, 10) || 276;
  const processed = done.length + failed.length;
  // A resumed batch starts at lastProcessed - processed + 1, so the bar shows
  // the accounts this run actually has left (43 for shard-2), not the whole
  // 127-account shard range.
  const batchStart = isDemo
    ? rangeStart
    : Math.max(
        rangeStart,
        (Number.isFinite(state?.lastProcessedIndex) ? state.lastProcessedIndex : rangeStart) - processed + 1
      );
  const total = isDemo ? demoTotal : Math.max(1, rangeEnd - batchStart + 1);
  const msValues = done.map((event) => Number(event.data?.ms)).filter((value) => Number.isFinite(value));

  const steps = events.filter((event) => event.kind === 'step');
  const lastStep = steps[steps.length - 1] || null;

  return {
    generatedAt: new Date().toISOString(),
    service,
    mode: isDemo ? 'demo' : 'live',
    server: { startedAt: serverStartedAt, port: activePort },
    status: status
      ? { state: status.state, nextRunAt: status.nextRunAt, run: status.run, group: status.group }
      : null,
    state: state
      ? {
          batchId: state.batchId,
          lastProcessedIndex: state.lastProcessedIndex,
          totalAccounts: state.totalAccounts,
          updatedAt: state.updatedAt
        }
      : null,
    summary,
    progress: {
      processed,
      total,
      percent: Math.min(100, Math.round((processed / Math.max(1, total)) * 1000) / 10),
      rangeStart,
      rangeEnd,
      batchStart,
      lastProcessedIndex: state?.lastProcessedIndex ?? null,
      demoIndices: isDemo ? process.env.DEMO_INDICES || null : null
    },
    current,
    batch: {
      id: batchId,
      ok: done.length,
      failed: failed.length,
      retries: done.reduce((sum, event) => sum + (Number(event.data?.retries) || 0), 0),
      avgMs: msValues.length ? Math.round(msValues.reduce((a, b) => a + b, 0) / msValues.length) : null,
      numbers: batchNumbers.size,
      sent: sent.length,
      skipped: skipped.length,
      sendFailed: sendFailed.length,
      lastStep: lastStep
        ? { step: lastStep.step, stepLabel: stepLabel(lastStep.step), account: lastStep.account, at: lastStep.ts }
        : null
    },
    numbers,
    shots: shots.map((shot) => ({
      file: shot.file,
      at: shot.at,
      number: shot.number,
      url: `/shots/${encodeURIComponent(shot.file)}`
    })),
    ledger,
    safety: {
      block: {
        blocked: !!block?.blocked,
        until: block?.blockedUntil || null,
        minutesLeft: block?.blocked ? minutesUntil(block.blockedUntil) : null,
        reason: block?.reason || null,
        count: block?.blockCount || 0,
        recoveredAt: block?.recoveredAt || null
      },
      gate: {
        disabled: !!gate?.disabled,
        reason: gate?.reason || null,
        nextCheckAt: gate?.nextCheckAt || null,
        minutesToCheck: gate?.disabled ? minutesUntil(gate.nextCheckAt) : null,
        probeCount: gate?.probeCount || 0,
        restoredAt: gate?.restoredAt || null
      }
    },
    totals: {
      screenshots: shotsTotal(),
      uniqueNumbers: ledger.total
    },
    events: events.map((event) => ({
      ts: event.ts,
      kind: event.kind,
      step: event.step || null,
      account: event.account || null,
      phase: event.phase || null,
      role: event.role || null,
      data: event.data || null
    })),
    log
  };
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon'
};

const serverStartedAt = new Date().toISOString();
let activePort = requestedPort;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function safeStatic(base, name) {
  const clean = path.basename(decodeURIComponent(name));
  const full = path.join(base, clean);
  return full.startsWith(path.resolve(base)) ? full : null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${activePort}`);

  if (url.pathname === '/api/state') {
    try {
      send(res, 200, JSON.stringify(fleetMode ? fleetSnapshot() : snapshot()));
    } catch (error) {
      send(res, 500, JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (url.pathname === '/health') {
    send(res, 200, JSON.stringify({ ok: true, service, port: activePort }));
    return;
  }

  if (fleetMode && url.pathname.startsWith('/shots/')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const id = parts[1];
    const name = parts.slice(2).join('/');
    const service = fleetIds.map(servicePaths).find((item) => item.id === id);
    const file = service && name ? safeStatic(service.shots, name) : null;
    if (file && existsSync(file)) {
      send(res, 200, readFileSync(file), MIME['.png']);
    } else {
      send(res, 404, 'not found', 'text/plain; charset=utf-8');
    }
    return;
  }

  if (!fleetMode && url.pathname.startsWith('/shots/')) {
    const file = safeStatic(paths.shots, url.pathname.slice('/shots/'.length));
    if (file && existsSync(file)) {
      send(res, 200, readFileSync(file), MIME['.png']);
    } else {
      send(res, 404, 'not found', 'text/plain; charset=utf-8');
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/dashboard') {
    const page = fleetMode ? paths.fleet : paths.dashboard;
    if (existsSync(page)) {
      send(res, 200, readFileSync(page), MIME['.html']);
    } else {
      send(res, 500, `${path.basename(page)} is missing`, 'text/plain; charset=utf-8');
    }
    return;
  }

  send(res, 404, 'not found', 'text/plain; charset=utf-8');
});

function openBrowser(target) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // headless box: the URL is printed anyway
  }
}

function listen(port, attemptsLeft = 10) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`[demo-watch] ${error.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    activePort = port;
    const target = `http://127.0.0.1:${port}/`;
    console.log(`[demo-watch] ${service} control room: ${target}`);
    console.log(`[demo-watch] snapshot: ${target}api/state`);
    if (shouldOpen) openBrowser(target);
  });
}

process.on('SIGINT', () => {
  console.log('\n[demo-watch] stopping');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});

listen(requestedPort);
