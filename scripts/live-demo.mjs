// live-demo.mjs
// Control + monitor panel for the manager meeting.
//
//   node scripts/live-demo.mjs --port 8788 --open
//
// What it does:
//   * starts/stops each headed demo shard (1xbet shard 1, 1xbet shard 2,
//     melbet) on demand, or all three, from the browser panel
//   * measures system CPU/RAM, plus CPU/RAM per shard (process tree)
//   * records the 1-shard baseline and the 3-shard average automatically
//   * measures capture -> Telegram delivery time for every dial, and how long
//     the first / next unique dial takes
//   * mirrors new screenshots into demo/live so one Explorer window fills up
//
// Demo runs use demo/seen-numbers-demo.json and TELEGRAM_CHANNEL_ID=off, so
// production ledger and the public channel are never touched.

import { createServer } from 'http';
import {
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  copyFileSync,
  writeFileSync
} from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const ROOT = process.cwd();
const MELBET = path.resolve(ROOT, '..', 'melbet-autologin');
const DEMO = path.join(ROOT, 'demo');
const LIVE = path.join(DEMO, 'live');
const LEDGER = path.join(DEMO, 'seen-numbers-demo.json');
const LEDGER_LOCK = `${LEDGER}.lock`;
const EVENTS = path.join(ROOT, 'events');
const MELBET_XLSX = path.join(MELBET, 'extracted_numbers-1.xlsx');
const MELBET_XLSX_BACKUP = path.join(DEMO, 'melbet-excel-backup.xlsx');
const PWSH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function arg(name, fallback) {
  const withEq = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

const requestedPort = parseInt(arg('port', process.env.LIVE_DEMO_PORT || '8788'), 10);
const shouldOpen = process.argv.includes('--open');
// Eight headed Chromium trees do not fit in this laptop's RAM. "Start all"
// launches this many and promotes the queued services as slots free up.
const maxConcurrent = Math.max(1, parseInt(arg('max-concurrent', process.env.LIVE_DEMO_MAX_CONCURRENT || '3'), 10) || 3);

const SERVICES = {
  'demo-s1': {
    id: 'demo-s1',
    label: '1xbet shard 1',
    short: '1xbet · 1',
    service: 'demo-s1',
    shots: path.join(ROOT, 'screenshots', 'demo-s1'),
    range: '1–149',
    script: 'scripts/demo-shard.ps1',
    args: ['-Service', 'demo-s1', '-Start', '1', '-End', '149', '-DelayMs', '20000'],
    cache: 'demo-s1',
    summary: path.join(ROOT, 'run-summary-demo-s1.json')
  },
  'demo-s2': {
    id: 'demo-s2',
    label: '1xbet shard 2',
    short: '1xbet · 2',
    service: 'demo-s2',
    shots: path.join(ROOT, 'screenshots', 'demo-s2'),
    range: '150–276',
    script: 'scripts/demo-shard.ps1',
    args: ['-Service', 'demo-s2', '-Start', '150', '-End', '276', '-DelayMs', '20000'],
    cache: 'demo-s2',
    summary: path.join(ROOT, 'run-summary-demo-s2.json')
  },
  melbet: {
    id: 'melbet',
    label: 'Melbet',
    short: 'melbet',
    service: 'melbet',
    shots: path.join(ROOT, 'screenshots', 'demo-melbet'),
    range: '1–271',
    script: 'scripts/demo-melbet.ps1',
    args: ['-Start', '1', '-End', '271', '-DelaySec', '20'],
    cache: 'demo-melbet'
  },
  betjam: {
    id: 'betjam',
    label: 'BetJam',
    short: 'betjam',
    service: 'betjam',
    shots: path.join(ROOT, 'screenshots', 'betjam'),
    range: '1–276',
    script: 'scripts/demo-service.ps1',
    args: ['-Service', 'betjam', '-Start', '1', '-End', '276', '-DelayMs', '20000'],
    cache: 'demo-betjam',
    summary: path.join(DEMO, 'run-summary-betjam.json')
  },
  fastpari: {
    id: 'fastpari',
    label: 'FastPari',
    short: 'fastpari',
    service: 'fastpari',
    shots: path.join(ROOT, 'screenshots', 'fastpari'),
    range: '1–276',
    script: 'scripts/demo-service.ps1',
    args: ['-Service', 'fastpari', '-Start', '1', '-End', '276', '-DelayMs', '20000'],
    cache: 'demo-fastpari',
    summary: path.join(DEMO, 'run-summary-fastpari.json')
  },
  lilbet: {
    id: 'lilbet',
    label: 'Lilbet',
    short: 'lilbet',
    service: 'lilbet',
    shots: path.join(ROOT, 'screenshots', 'lilbet'),
    range: '1–278',
    script: 'scripts/demo-service.ps1',
    // The autologin repo only has one row; demo-service points ACCOUNTS_FILE
    // at lilbet-autoreg's full 278-account list.
    args: ['-Service', 'lilbet', '-Start', '1', '-End', '278', '-DelayMs', '20000'],
    cache: 'demo-lilbet',
    summary: path.join(DEMO, 'run-summary-lilbet.json')
  },
  linebet: {
    id: 'linebet',
    label: 'Linebet',
    short: 'linebet',
    service: 'linebet',
    shots: path.join(ROOT, 'screenshots', 'linebet'),
    range: '1–130',
    script: 'scripts/demo-service.ps1',
    args: ['-Service', 'linebet', '-Start', '1', '-End', '130', '-DelayMs', '20000'],
    cache: 'demo-linebet',
    summary: path.join(DEMO, 'run-summary-linebet.json')
  },
  paripulse: {
    id: 'paripulse',
    label: 'PariPulse',
    short: 'paripulse',
    service: 'paripulse',
    shots: path.join(ROOT, 'screenshots', 'paripulse'),
    range: '1–276',
    script: 'scripts/demo-service.ps1',
    args: ['-Service', 'paripulse', '-Start', '1', '-End', '276', '-DelayMs', '20000'],
    cache: 'demo-paripulse',
    summary: path.join(DEMO, 'run-summary-paripulse.json')
  }
};
const SERVICE_IDS = Object.keys(SERVICES);

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function fileAgeMs(file) {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

function readPid(file) {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

// taskkill /T is not reliable for a PowerShell -> npx.cmd -> Playwright tree:
// children can be re-parented and survive. Walk the tree explicitly, kill
// children first, and repeat in case a wrapper spawned something mid-kill.
function killTree(pid) {
  if (!pid) return;
  const script = `
$ErrorActionPreference='SilentlyContinue'
$root = ${Number(pid)}
for ($round = 0; $round -lt 3; $round++) {
  $all = Get-CimInstance Win32_Process
  $byParent = @{}
  foreach ($p in $all) {
    $pp = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = New-Object System.Collections.ArrayList }
    [void]$byParent[$pp].Add([int]$p.ProcessId)
  }
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  $pids = New-Object System.Collections.ArrayList
  while ($stack.Count -gt 0) {
    $cur = [int]$stack.Pop()
    [void]$pids.Add($cur)
    if ($byParent.ContainsKey($cur)) { foreach ($c in $byParent[$cur]) { $stack.Push($c) } }
  }
  foreach ($id in ($pids | Sort-Object -Descending)) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 250
}
`;
  spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
}

// Leftover pid files from a force-closed panel can block a start if Windows
// recycles the pid, so drop any whose process is no longer alive.
function sweepStalePids() {
  for (const id of SERVICE_IDS) {
    const file = demoPidPath(id);
    const pid = readPid(file);
    if (pid && !isAlive(pid)) {
      try {
        rmSync(file, { force: true });
      } catch {
        // already gone
      }
    }
  }
}

// A panel that is force-closed (or crashes) cannot run stopAll, so its detached
// service trees keep running with no card controlling them. Sweep them on boot:
// demo wrappers, demo Chromium instances, and orphaned senders/Playwright chains
// whose parent is gone. Never touches anything while the production farm runs.
function killDemoLeftovers() {
  if (farmStatus().running) return;
  const script = `
$ErrorActionPreference='SilentlyContinue'
$me = $PID
$all = Get-CimInstance Win32_Process
$alive = @{}
foreach ($p in $all) { $alive[[int]$p.ProcessId] = $true }
$byParent = @{}
foreach ($p in $all) {
  $pp = [int]$p.ParentProcessId
  if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = New-Object System.Collections.ArrayList }
  [void]$byParent[$pp].Add([int]$p.ProcessId)
}
$roots = New-Object System.Collections.Generic.HashSet[int]
foreach ($p in $all) {
  if ([int]$p.ProcessId -eq $me) { continue }
  $cl = $p.CommandLine
  if (-not $cl) { continue }
  if ($cl -match 'demo-service\\.ps1|demo-shard\\.ps1|demo-melbet\\.ps1') { [void]$roots.Add([int]$p.ProcessId); continue }
  if ($p.Name -eq 'chrome.exe' -and $cl -match 'browser-cache\\\\demo-') { [void]$roots.Add([int]$p.ProcessId); continue }
  if (-not $alive[[int]$p.ParentProcessId]) {
    if ($cl -match 'realtime-send\\.mjs') { [void]$roots.Add([int]$p.ProcessId); continue }
    if ($cl -match 'playwright test --workers=1 --reporter=line') { [void]$roots.Add([int]$p.ProcessId); continue }
    if ($cl -match 'npx-cli\\.js.*playwright test') { [void]$roots.Add([int]$p.ProcessId); continue }
  }
}
$kill = New-Object System.Collections.Generic.HashSet[int]
$stack = New-Object System.Collections.Stack
foreach ($r in $roots) { $stack.Push($r) }
while ($stack.Count -gt 0) {
  $cur = [int]$stack.Pop()
  if (-not $kill.Add($cur)) { continue }
  if ($byParent.ContainsKey($cur)) { foreach ($c in $byParent[$cur]) { $stack.Push($c) } }
}
foreach ($id in ($kill | Sort-Object -Descending)) {
  if ($id -ne $me) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}
`;
  spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function demoPidPath(id) {
  return path.join(ROOT, 'shards', `live-demo-${id}.pid`);
}

// ---------------------------------------------------------------------------
// session state
// ---------------------------------------------------------------------------

const session = {
  startedAt: null,
  resetAt: null,
  endedAt: null
};

const tracked = Object.fromEntries(
  SERVICE_IDS.map((id) => [id, { pid: null, startedAt: null, finishedAt: null, state: 'idle' }])
);

// Services waiting for a free slot after "Start all".
let startQueue = [];

const delivery = {
  resolved: [],
  seen: new Set()
};

const metrics = {
  accounts: Object.fromEntries(SERVICE_IDS.map((id) => [id, 0])),
  uniqueByService: Object.fromEntries(SERVICE_IDS.map((id) => [id, 0])),
  firstSeen: Object.fromEntries(SERVICE_IDS.map((id) => [id, new Map()])),
  shots: Object.fromEntries(SERVICE_IDS.map((id) => [id, 0])),
  // Files ever seen this session, so the "n done" counter stays cumulative even
  // after the sender's retention sweep deletes old screenshots from disk.
  shotNames: Object.fromEntries(SERVICE_IDS.map((id) => [id, new Set()])),
  shotFiles: [],
  // resource baselines
  solo: { samples: 0, cpuSum: 0, ramSum: 0, peakCpu: 0, peakRamMb: 0 },
  fleet: { samples: 0, cpuSum: 0, ramSum: 0, peakCpu: 0, peakRamMb: 0, maxRunning: 0 },
  peaks: { cpu: 0, ramMb: 0, lowFreeMb: Number.POSITIVE_INFINITY },
  lastSampleAt: 0
};

let eventOffsets = new Map();

function resetSessionState() {
  metrics.accounts = Object.fromEntries(SERVICE_IDS.map((id) => [id, 0]));
  metrics.uniqueByService = Object.fromEntries(SERVICE_IDS.map((id) => [id, 0]));
  metrics.firstSeen = Object.fromEntries(SERVICE_IDS.map((id) => [id, new Map()]));
  metrics.shots = Object.fromEntries(SERVICE_IDS.map((id) => [id, 0]));
  metrics.shotNames = Object.fromEntries(SERVICE_IDS.map((id) => [id, new Set()]));
  metrics.shotFiles = [];
  metrics.solo = { samples: 0, cpuSum: 0, ramSum: 0, peakCpu: 0, peakRamMb: 0 };
  metrics.fleet = { samples: 0, cpuSum: 0, ramSum: 0, peakCpu: 0, peakRamMb: 0, maxRunning: 0 };
  metrics.peaks = { cpu: 0, ramMb: 0, lowFreeMb: Number.POSITIVE_INFINITY };
  delivery.resolved = [];
  delivery.seen = new Set();
  eventOffsets = new Map();
}

function cleanDemoArtifacts() {
  ensureDir(DEMO);
  ensureDir(LIVE);
  ensureDir(EVENTS);

  // Melbet rewrites extracted_numbers-1.xlsx in place at the end of a pass.
  // Keep the real one safe even if the demo is stopped hard (taskkill skips the
  // script's finally), but never overwrite an existing backup: after a hard kill
  // the repo file may already hold demo data, and copying that over the good
  // backup would make the damage permanent.
  try {
    if (!existsSync(MELBET_XLSX_BACKUP) && existsSync(MELBET_XLSX)) {
      copyFileSync(MELBET_XLSX, MELBET_XLSX_BACKUP);
    }
  } catch {
    // best effort; production file is untouched until melbet starts
  }

  // Fresh demo ledger: every number is new for this demo, so the sender
  // delivers it and we can measure capture -> Telegram latency.
  writeFileSync(LEDGER, `${JSON.stringify({ updatedAt: new Date().toISOString(), numbers: [] }, null, 2)}\n`);
  try {
    rmSync(LEDGER_LOCK, { recursive: true, force: true });
  } catch {
    // lock already gone
  }

  for (const id of SERVICE_IDS) {
    const dir = SERVICES[id].shots;
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (/\.(png|jpe?g)$/i.test(name)) {
          try {
            rmSync(path.join(dir, name), { force: true });
          } catch {
            // leave it
          }
        }
      }
    }
    ensureDir(dir);
    const artifacts = [
      `state-${id}.json`,
      `auth-state-${id}.json`,
      `run-summary-${id}.json`,
      `loop-status-${id}.json`,
      `extracted_numbers-${id}.xlsx`,
      `extracted_numbers-${id}.json`,
      `extracted-${id}.jsonl`,
      `failed-${id}.log`,
      `failures-${id}.jsonl`
    ];
    for (const file of artifacts) {
      for (const base of [ROOT, DEMO]) {
        try {
          rmSync(path.join(base, file), { force: true });
        } catch {
          // nothing to remove
        }
      }
    }
    for (const name of readdirSync(EVENTS).filter((n) => n.startsWith(`${id}-`))) {
      try {
        rmSync(path.join(EVENTS, name), { force: true });
      } catch {
        // leave it
      }
    }
  }

  for (const name of readdirSync(LIVE)) {
    try {
      rmSync(path.join(LIVE, name), { force: true });
    } catch {
      // leave it
    }
  }
}

function beginSession() {
  resetSessionState();
  cleanDemoArtifacts();
  session.startedAt = Date.now();
  session.endedAt = null;
}

function endSession() {
  session.endedAt = Date.now();
}

// ---------------------------------------------------------------------------
// process sampling (needs PowerShell: os.cpus only covers the whole machine)
// ---------------------------------------------------------------------------

const procCache = {
  at: 0,
  busy: false,
  map: new Map(),
  trees: new Map(),
  node: { count: 0, mb: 0 },
  chrome: { count: 0, mb: 0 }
};

const SAMPLE_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$inv=[Globalization.CultureInfo]::InvariantCulture",
  "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='node.exe' OR Name='powershell.exe' OR Name='cmd.exe'\" | ForEach-Object {",
  "  $cpu=($_.UserModeTime + $_.KernelModeTime)/10000000",
  "  '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId,$_.ParentProcessId,$_.Name,$cpu.ToString($inv),$_.WorkingSetSize",
  '}'
].join('\n');

function sampleProcesses() {
  if (procCache.busy || Date.now() - procCache.at < 1800) return;
  procCache.busy = true;

  let output = '';
  const child = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-Command', SAMPLE_SCRIPT], {
    windowsHide: true
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  const finish = () => {
    const map = new Map();
    const trees = new Map();
    if (process.env.LIVE_DEMO_DEBUG) console.error(`[live-demo] sample lines=${output.split(/\r?\n/).filter(Boolean).length}`);
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      if (parts.length < 5) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const name = parts[2];
      const cpu = Number(parts[3]);
      const ws = Number(parts[4]);
      const cmd = parts.slice(5).join('|');
      if (!Number.isFinite(pid)) continue;
      map.set(pid, { pid, ppid, name, cpu, ws, cmd });
    }
    for (const proc of map.values()) {
      const key = proc.ppid;
      if (!trees.has(key)) trees.set(key, []);
      trees.get(key).push(proc);
    }

    let nodeCount = 0;
    let nodeMb = 0;
    let chromeCount = 0;
    let chromeMb = 0;
    for (const proc of map.values()) {
      if (proc.name === 'node.exe') {
        nodeCount += 1;
        nodeMb += proc.ws;
      } else if (proc.name.startsWith('chrome')) {
        chromeCount += 1;
        chromeMb += proc.ws;
      }
    }

    procCache.map = map;
    procCache.trees = trees;
    procCache.node = { count: nodeCount, mb: Math.round(nodeMb / 1024 / 1024) };
    procCache.chrome = { count: chromeCount, mb: Math.round(chromeMb / 1024 / 1024) };
    procCache.at = Date.now();
    procCache.busy = false;

    attributeResources();
  };
  child.on('close', finish);
  child.on('error', () => {
    procCache.busy = false;
  });
  child.stderr.on('data', (chunk) => {
    if (process.env.LIVE_DEMO_DEBUG) console.error(`[live-demo] sample: ${chunk.toString().trim()}`);
  });
}

const procPrevCpu = new Map();
let lastAttributionAt = 0;

function attributeResources() {
  const roots = new Map();
  for (const id of SERVICE_IDS) {
    const entry = tracked[id];
    if (entry.pid) roots.set(entry.pid, id);
  }

  const totals = Object.fromEntries(SERVICE_IDS.map((id) => [id, { cpu: 0, ws: 0, browsers: 0 }]));
  const owned = [];

  for (const proc of procCache.map.values()) {
    let cursor = proc;
    let owner = null;
    for (let step = 0; step < 14 && cursor; step += 1) {
      if (roots.has(cursor.pid)) {
        owner = roots.get(cursor.pid);
        break;
      }
      cursor = procCache.map.get(cursor.ppid);
    }
    if (!owner) continue;
    const bucket = totals[owner];
    const cpu = Number.isFinite(proc.cpu) ? proc.cpu : 0;
    bucket.cpu += cpu;
    bucket.ws += proc.ws || 0;
    if (proc.name.startsWith('chrome')) {
      // Count browser roots, not every Chromium subprocess: one visible
      // browser per shard is what the room expects to see.
      const parent = procCache.map.get(proc.ppid);
      if (!parent || !parent.name.startsWith('chrome')) bucket.browsers += 1;
    }
    owned.push({ pid: proc.pid, owner, cpu });
  }

  // CPU from per-process deltas, not the tree total: Chromium recycles
  // renderer processes, so a shrinking tree total would read as 0%.
  const now = Date.now();
  const elapsed = lastAttributionAt ? (now - lastAttributionAt) / 1000 : 0;
  const cores = Math.max(1, os.cpus().length);
  const deltas = Object.fromEntries(SERVICE_IDS.map((id) => [id, 0]));
  if (elapsed > 0) {
    for (const item of owned) {
      const before = procPrevCpu.get(item.pid);
      if (before === undefined) continue;
      const delta = item.cpu - before;
      if (delta > 0) deltas[item.owner] += delta;
    }
  }

  procPrevCpu.clear();
  for (const proc of procCache.map.values()) {
    procPrevCpu.set(proc.pid, Number.isFinite(proc.cpu) ? proc.cpu : 0);
  }
  lastAttributionAt = now;

  for (const id of SERVICE_IDS) {
    const value = totals[id];
    const cpuPercent = elapsed > 0 ? Math.round((deltas[id] / elapsed / cores) * 100) : 0;
    tracked[id].cpuPercent = Math.min(100 * cores, cpuPercent);
    tracked[id].ramMb = Math.round(value.ws / 1024 / 1024);
    tracked[id].browsers = value.browsers;
  }
}

// ---------------------------------------------------------------------------
// system CPU
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

// ---------------------------------------------------------------------------
// screenshots: unique dials + live folder mirror
// ---------------------------------------------------------------------------

let shotScanAt = 0;

function scanShots() {
  if (Date.now() - shotScanAt < 1800) return;
  shotScanAt = Date.now();
  const startAt = session.startedAt;
  if (!startAt) return;
  const wall = [];

  for (const id of SERVICE_IDS) {
    const dir = SERVICES[id].shots;
    const firstSeen = metrics.firstSeen[id];
    const seenNames = metrics.shotNames[id];
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!/\.(png|jpe?g)$/i.test(name)) continue;
        const full = path.join(dir, name);
        let info;
        try {
          info = statSync(full);
        } catch {
          continue;
        }
        if (info.mtimeMs < startAt - 3000) continue;
        seenNames.add(name);

        const match = name.match(/(01\d{9})/);
        const number = match ? match[1] : null;
        if (number) {
          const at = Math.min(firstSeen.get(number) ?? info.mtimeMs, info.mtimeMs);
          firstSeen.set(number, at);
          wall.push({
            service: id,
            short: SERVICES[id].short,
            file: name,
            number,
            at,
            url: `/shots/${id}/${encodeURIComponent(name)}`
          });
        }

        const linkName = `${id}__${name}`;
        const target = path.join(LIVE, linkName);
        if (!existsSync(target)) {
          try {
            linkSync(full, target);
          } catch {
            try {
              copyFileSync(full, target);
            } catch {
              // mirror is best-effort
            }
          }
        }
      }
    }
    metrics.shots[id] = seenNames.size;
    metrics.uniqueByService[id] = firstSeen.size;
  }

  wall.sort((a, b) => b.at - a.at);
  metrics.shotFiles = wall;
  sweepLiveMirror();
}

// demo/live entries are hard links named "<service>__<file>". Once the sender's
// retention sweep deletes the original, the link alone still holds the bytes on
// disk, so remove links whose source is gone. Without this, retention frees
// nothing and the Explorer window keeps showing deleted dials.
function sweepLiveMirror() {
  let names = [];
  try {
    names = readdirSync(LIVE);
  } catch {
    return;
  }

  for (const name of names) {
    const sep = name.indexOf('__');
    if (sep <= 0) continue;
    const id = name.slice(0, sep);
    const file = name.slice(sep + 2);
    if (!SERVICES[id]) continue;
    if (existsSync(path.join(SERVICES[id].shots, file))) continue;
    try {
      rmSync(path.join(LIVE, name), { force: true });
    } catch {
      // next scan retries
    }
  }
}

// ---------------------------------------------------------------------------
// events: accounts done + Telegram deliveries
// ---------------------------------------------------------------------------

function parseEvents() {
  if (!session.startedAt || session.endedAt) return;
  const startAt = session.startedAt;
  const now = Date.now();
  let names = [];
  try {
    names = readdirSync(EVENTS).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return;
  }

  for (const name of names) {
    const full = path.join(EVENTS, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.mtimeMs < startAt - 60000) continue;

    let offset = eventOffsets.get(full);
    if (offset === undefined) offset = 0;
    if (offset > info.size) offset = 0; // truncated
    if (offset === info.size) continue;

    let chunk = '';
    try {
      const fd = openSync(full, 'r');
      const buffer = Buffer.alloc(info.size - offset);
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      closeSync(fd);
      chunk = buffer.subarray(0, read).toString('utf8');
    } catch {
      continue;
    }
    eventOffsets.set(full, info.size);

    const lines = chunk.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event || !event.ts) continue;
      const at = Date.parse(event.ts);
      if (!Number.isFinite(at) || at < startAt - 60000) continue;
      const svc = event.svc;
      if (!SERVICE_IDS.includes(svc)) continue;

      if (event.kind === 'account.done') {
        metrics.accounts[svc] = (metrics.accounts[svc] || 0) + 1;
      } else if (event.kind === 'send.ok' && event.data?.number) {
        const key = `${svc}|${event.data.number}|${event.ts}`;
        if (!delivery.seen.has(key)) {
          delivery.seen.add(key);
          delivery.resolved.push({
            service: svc,
            number: event.data.number,
            sentAt: at,
            captureAt: null,
            latencyMs: null
          });
        }
      }
    }
  }

  // Resolve capture -> delivery latency as soon as the matching shot is known.
  for (const item of delivery.resolved) {
    if (item.latencyMs !== null) continue;
    const firstSeen = metrics.firstSeen[item.service];
    if (!firstSeen) continue;
    const capturedAt = firstSeen.get(item.number);
    if (!capturedAt) continue;
    if (capturedAt > item.sentAt + 5000) continue;
    item.captureAt = capturedAt;
    item.latencyMs = Math.max(0, item.sentAt - capturedAt);
  }
}

// ---------------------------------------------------------------------------
// farm status
// ---------------------------------------------------------------------------

function farmStatus() {
  const files = {
    'shard-1': path.join(ROOT, 'shards', 'shard-1.pid'),
    'shard-2': path.join(ROOT, 'shards', 'shard-2.pid'),
    melbet: path.join(ROOT, 'shards', 'melbet.pid')
  };
  const alive = {};
  let any = false;
  for (const [id, file] of Object.entries(files)) {
    const pid = readPid(file);
    const isAliveNow = isAlive(pid);
    alive[id] = isAliveNow;
    if (isAliveNow) any = true;
  }
  return { running: any, services: alive };
}

// ---------------------------------------------------------------------------
// control
// ---------------------------------------------------------------------------

function startService(id) {
  const cfg = SERVICES[id];
  if (!cfg) throw new Error(`unknown service ${id}`);
  startQueue = startQueue.filter((queued) => queued !== id);
  if (tracked[id].pid) throw new Error(`${cfg.label} is already running`);
  const existing = readPid(demoPidPath(id));
  if (isAlive(existing)) {
    let fresh = false;
    try {
      fresh = Date.now() - statSync(demoPidPath(id)).mtimeMs < 2 * 3600 * 1000;
    } catch {
      fresh = false;
    }
    if (fresh) {
      throw new Error(`${cfg.label} is already running (pid ${existing}). Restart the panel or stop it first.`);
    }
  }
  if (farmStatus().running) {
    throw new Error('The production farm is running — click "Pause farm" first.');
  }
  if (!session.startedAt || session.endedAt) beginSession();

  ensureDir(SERVICES[id].shots);
  ensureDir(DEMO);
  ensureDir(LIVE);

  const log = path.join(ROOT, 'logs', `live-demo-${id}.log`);
  const err = path.join(ROOT, 'logs', `live-demo-${id}.err.log`);
  ensureDir(path.dirname(log));
  const outFd = openSync(log, 'a');
  const errFd = openSync(err, 'a');

  const child = spawn(
    PWSH,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, cfg.script), ...cfg.args],
    {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd]
    }
  );
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  child.on('error', (error) => {
    console.error(`[live-demo] ${id} failed to start: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    console.log(`[live-demo] ${id} exited code=${code} signal=${signal || ''}`);
  });

  tracked[id] = { pid: child.pid, startedAt: Date.now(), finishedAt: null, state: 'running', cpuPercent: 0, ramMb: 0, browsers: 0 };
  ensureDir(path.join(ROOT, 'shards'));
  writeFileSync(demoPidPath(id), String(child.pid));
  return { id, pid: child.pid };
}

function restoreMelbetExcel() {
  try {
    if (existsSync(MELBET_XLSX_BACKUP)) copyFileSync(MELBET_XLSX_BACKUP, MELBET_XLSX);
  } catch {
    // the demo file stays; production export is restored on the next attempt
  }
}

function stopService(id) {
  const entry = tracked[id];
  if (!entry) throw new Error(`unknown service ${id}`);
  startQueue = startQueue.filter((queued) => queued !== id);
  if (!entry.pid) {
    tracked[id] = { ...entry, state: 'idle', cpuPercent: 0, ramMb: 0, browsers: 0 };
    return { id, cancelled: true };
  }
  killTree(entry.pid);
  // Safety net: kill any Chromium still pointing at this demo cache dir.
  const cacheName = SERVICES[id].cache || id;
  spawnSync(PWSH, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'browser-cache\\\\${cacheName}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  ], { windowsHide: true });
  if (id === 'melbet') restoreMelbetExcel();
  try {
    rmSync(demoPidPath(id), { force: true });
  } catch {
    // already gone
  }
  tracked[id] = { ...entry, pid: null, state: 'idle', finishedAt: Date.now(), cpuPercent: 0, ramMb: 0, browsers: 0 };
  return { id };
}

function stopAll() {
  startQueue = [];
  const stopped = [];
  // Iterate backwards: stopService prunes the queue, never the id list.
  for (const id of SERVICE_IDS) {
    if (tracked[id].pid) {
      try {
        stopService(id);
        stopped.push(id);
      } catch {
        // keep going
      }
    }
  }
  return stopped;
}

function activeCount() {
  return SERVICE_IDS.reduce((count, id) => count + (tracked[id].pid && isAlive(tracked[id].pid) ? 1 : 0), 0);
}

// Promote queued services as running ones finish. Called from every snapshot,
// so the panel does not need a separate scheduler process.
function pumpQueue() {
  if (startQueue.length === 0) return;
  if (!session.startedAt || session.endedAt) {
    startQueue = [];
    return;
  }
  while (startQueue.length > 0 && activeCount() < maxConcurrent) {
    const id = startQueue.shift();
    if (tracked[id].pid) continue;
    try {
      startService(id);
    } catch (error) {
      console.error(`[live-demo] queued ${id} could not start: ${error.message}`);
    }
  }
}

function startMany(ids) {
  if (farmStatus().running) {
    throw new Error('The production farm is running — click "Pause farm" first.');
  }
  startQueue = [];
  const started = [];
  const errors = [];
  for (const id of ids) {
    if (SERVICES[id] && !tracked[id].pid) startQueue.push(id);
  }
  while (startQueue.length > 0 && activeCount() < maxConcurrent) {
    const id = startQueue.shift();
    try {
      started.push(startService(id));
    } catch (error) {
      errors.push(`${id}: ${error.message}`);
    }
  }
  if (started.length === 0) startQueue = [];
  return { started, queued: [...startQueue], errors, maxConcurrent };
}

function startAll() {
  return startMany(SERVICE_IDS);
}

const EXTERNAL_SERVICES = ['betjam', 'fastpari', 'lilbet', 'linebet', 'paripulse'];

function runDetached(command, args) {
  const child = spawn(command, args, { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

const CONTROL = {
  start: (body) => startService(body.service),
  stop: (body) => stopService(body.service),
  'start-all': () => startAll(),
  'start-external': () => startMany(EXTERNAL_SERVICES),
  'stop-all': () => ({ stopped: stopAll() }),
  pause: () => {
    startQueue = [];
    spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'stop-pipeline.ps1'), '-All'], {
      cwd: ROOT,
      windowsHide: true,
      timeout: 90000
    });
    return { paused: true };
  },
  restore: () => {
    if (startQueue.length > 0 || SERVICE_IDS.some((id) => isAlive(tracked[id].pid))) {
      throw new Error('Stop the demo services before restoring the farm.');
    }
    if (farmStatus().running) return { restored: false, note: 'farm already running' };
    runDetached(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'run-all-shards.ps1'), '-Resume']);
    return { restored: true };
  },
  taskmgr: () => {
    runDetached('taskmgr.exe', []);
    return { opened: true };
  },
  live: () => {
    ensureDir(LIVE);
    runDetached('explorer.exe', [LIVE]);
    return { opened: true };
  },
  focus: () => {
    spawnSync(PWSH, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Add-Type -Namespace Live -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);'; Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [Live.Win]::SetForegroundWindow($_.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 150 }"
    ], { windowsHide: true });
    return { focused: true };
  },
  reset: () => {
    stopAll();
    beginSession();
    return { reset: true };
  },
  end: () => {
    stopAll();
    endSession();
    return { ended: true };
  }
};

// ---------------------------------------------------------------------------
// state snapshot
// ---------------------------------------------------------------------------

// The five external services do not emit account.done events, so fall back to
// the demo run summary they write when the batch finishes.
function summaryAccounts(id) {
  const file = SERVICES[id].summary;
  if (!file) return 0;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const value = data.succeeded ?? data.totalAccounts ?? 0;
    return Number(value) || 0;
  } catch {
    return 0;
  }
}

function serviceState() {
  return SERVICE_IDS.map((id) => {
    const entry = tracked[id];
    const alive = isAlive(entry.pid);
    if (!alive && entry.state === 'running') {
      entry.state = 'finished';
      entry.finishedAt = entry.finishedAt || Date.now();
      entry.pid = null;
      if (id === 'melbet') restoreMelbetExcel();
      try {
        rmSync(demoPidPath(id), { force: true });
      } catch {
        // already gone
      }
    }
    return {
      id,
      label: SERVICES[id].label,
      short: SERVICES[id].short,
      range: SERVICES[id].range,
      state: entry.state,
      queued: startQueue.includes(id),
      pid: entry.pid,
      running: alive,
      cpuPercent: entry.cpuPercent || 0,
      ramMb: entry.ramMb || 0,
      browsers: entry.browsers || 0,
      screenshots: metrics.shots[id] || 0,
      unique: metrics.uniqueByService[id] || 0,
      // Only 1xbet emits account.done events; the other seven write one
      // screenshot per processed account, so use the larger of the two as the
      // live progress counter (and the run summary once a batch finishes).
      accounts: Math.max(metrics.accounts[id] || 0, metrics.shots[id] || 0, summaryAccounts(id)),
      delivered: delivery.resolved.filter((item) => item.service === id && item.latencyMs !== null).length
    };
  });
}

function uniqueStats(now) {
  const merged = new Map();
  for (const id of SERVICE_IDS) {
    for (const [number, at] of metrics.firstSeen[id]) {
      const current = merged.get(number);
      if (current === undefined || at < current) merged.set(number, at);
    }
  }
  const times = [...merged.values()].sort((a, b) => a - b);
  if (times.length === 0) {
    return { total: 0, firstAfterMs: null, avgGapMs: null, lastGapMs: null, ratePerHour: null };
  }
  const firstAt = times[0];
  const lastAt = times[times.length - 1];
  const span = lastAt - firstAt;
  const avgGapMs = times.length > 1 ? Math.round(span / (times.length - 1)) : null;
  const hours = Math.max(1 / 3600, (now - firstAt) / 3600000);
  return {
    total: times.length,
    firstAfterMs: session.startedAt ? firstAt - session.startedAt : null,
    avgGapMs,
    lastGapMs: now - lastAt,
    ratePerHour: Math.round((times.length / hours) * 10) / 10
  };
}

function deliveryStats(now) {
  const done = delivery.resolved.filter((item) => item.latencyMs !== null).sort((a, b) => a.sentAt - b.sentAt);
  if (done.length === 0) {
    return { total: 0, firstAfterMs: null, lastMs: null, avgMs: null, maxMs: null, ratePerHour: null, recent: [] };
  }
  const firstAt = done[0].sentAt;
  const latencies = done.map((item) => item.latencyMs);
  const hours = Math.max(1 / 3600, (now - firstAt) / 3600000);
  return {
    total: done.length,
    firstAfterMs: session.startedAt ? firstAt - session.startedAt : null,
    lastMs: latencies[latencies.length - 1],
    avgMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
    maxMs: Math.max(...latencies),
    ratePerHour: Math.round((done.length / hours) * 10) / 10,
    recent: done.slice(-8).reverse().map((item) => ({
      ...item,
      short: SERVICES[item.service]?.short || item.service
    }))
  };
}

function snapshot() {
  pumpQueue();
  sampleProcesses();
  scanShots();
  parseEvents();

  const now = Date.now();
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const cpu = cpuPercent();
  const services = serviceState();
  const running = services.filter((service) => service.running);

  // Baseline capture: samples while exactly one shard is up feed "solo",
  // samples with two or more feed "fleet".
  if (session.startedAt && !session.endedAt && running.length > 0) {
    const ramSum = running.reduce((sum, service) => sum + service.ramMb, 0);
    const cpuSum = running.reduce((sum, service) => sum + service.cpuPercent, 0);
    if (running.length === 1) {
      metrics.solo.samples += 1;
      metrics.solo.cpuSum += cpuSum;
      metrics.solo.ramSum += ramSum;
      metrics.solo.peakCpu = Math.max(metrics.solo.peakCpu, cpuSum);
      metrics.solo.peakRamMb = Math.max(metrics.solo.peakRamMb, ramSum);
    } else {
      metrics.fleet.samples += 1;
      metrics.fleet.cpuSum += cpuSum;
      metrics.fleet.ramSum += ramSum;
      metrics.fleet.peakCpu = Math.max(metrics.fleet.peakCpu, cpuSum);
      metrics.fleet.peakRamMb = Math.max(metrics.fleet.peakRamMb, ramSum);
      metrics.fleet.maxRunning = Math.max(metrics.fleet.maxRunning || 0, running.length);
    }
  }

  if (session.startedAt && !session.endedAt) {
    metrics.peaks.cpu = Math.max(metrics.peaks.cpu, cpu);
    metrics.peaks.ramMb = Math.max(metrics.peaks.ramMb, totalMb - freeMb);
    metrics.peaks.lowFreeMb = Math.min(metrics.peaks.lowFreeMb, freeMb);
  }

  const solo = metrics.solo.samples
    ? {
        cpu: Math.round(metrics.solo.cpuSum / metrics.solo.samples),
        ramMb: Math.round(metrics.solo.ramSum / metrics.solo.samples),
        peakCpu: metrics.solo.peakCpu,
        peakRamMb: metrics.solo.peakRamMb
      }
    : null;
  const fleet = metrics.fleet.samples
    ? {
        cpu: Math.round(metrics.fleet.cpuSum / metrics.fleet.samples),
        ramMb: Math.round(metrics.fleet.ramSum / metrics.fleet.samples),
        peakCpu: metrics.fleet.peakCpu,
        peakRamMb: metrics.fleet.peakRamMb,
        maxRunning: metrics.fleet.maxRunning || running.length
      }
    : null;

  const unique = uniqueStats(session.endedAt || now);
  const deliveryData = deliveryStats(session.endedAt || now);

  return {
    generatedAt: new Date(now).toISOString(),
    session: {
      startedAt: session.startedAt ? new Date(session.startedAt).toISOString() : null,
      endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
      elapsedMs: session.startedAt ? (session.endedAt || now) - session.startedAt : 0,
      active: !!session.startedAt && !session.endedAt
    },
    farm: farmStatus(),
    queue: { pending: startQueue.length, maxConcurrent },
    services,
    system: {
      cpuPercent: cpu,
      memUsedMb: totalMb - freeMb,
      memTotalMb: totalMb,
      memPercent: Math.round(((totalMb - freeMb) / totalMb) * 1000) / 10,
      freeMb,
      cores: os.cpus().length,
      node: procCache.node,
      browsers: {
        count: services.reduce((sum, service) => sum + service.browsers, 0),
        mb: services.reduce((sum, service) => sum + service.ramMb, 0)
      },
      peaks: {
        cpu: metrics.peaks.cpu,
        ramMb: metrics.peaks.ramMb,
        lowFreeMb: Number.isFinite(metrics.peaks.lowFreeMb) ? metrics.peaks.lowFreeMb : null
      }
    },
    comparison: { solo, fleet },
    unique,
    delivery: deliveryData,
    shots: metrics.shotFiles.slice(0, 10),
    live: LIVE
  };
}

// ---------------------------------------------------------------------------
// http server
// ---------------------------------------------------------------------------

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // Close the socket after every API reply. A panel tab can sit idle for
    // minutes between clicks; reusing a keep-alive socket the server already
    // closed is what makes a Start/Stop click fail with ECONNRESET.
    Connection: 'close',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveShot(req, res, service, name) {
  const cfg = SERVICES[service];
  if (!cfg || !name || name.includes('..') || /[\\/]/.test(name)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const full = path.join(cfg.shots, name);
  if (!existsSync(full)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' });
  createReadStream(full).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${server.address()?.port || requestedPort}`);

  if (url.pathname === '/api/state') {
    json(res, 200, snapshot());
    return;
  }

  if (url.pathname === '/api/control' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const handler = CONTROL[body.action];
      if (!handler) {
        json(res, 400, { ok: false, error: `unknown action ${body.action}` });
        return;
      }
      const result = await handler(body);
      json(res, 200, { ok: true, result });
    } catch (error) {
      json(res, 409, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname.startsWith('/shots/')) {
    const parts = url.pathname.split('/').filter(Boolean);
    serveShot(req, res, parts[1], decodeURIComponent(parts.slice(2).join('/')));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = readFileSync(path.join(ROOT, 'demo', 'live.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (error) {
      res.writeHead(500);
      res.end(`live.html missing: ${error.message}`);
    }
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true }).unref();
}

let listenPort = requestedPort;
let announced = false;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && listenPort < requestedPort + 10) {
    listenPort += 1;
    setTimeout(() => server.listen(listenPort, '127.0.0.1'), 60);
    return;
  }
  console.error(`[live-demo] listen failed: ${error.message}`);
  process.exit(1);
});

server.on('listening', () => {
  if (announced) return;
  announced = true;
  const actual = server.address().port;
  ensureDir(path.join(ROOT, 'shards'));
  // A panel restart must not inherit the previous run's screenshots or ledger,
  // nor leave a detached browser tree running with no card controlling it.
  killDemoLeftovers();
  sweepStalePids();
  cleanDemoArtifacts();
  writeFileSync(path.join(ROOT, 'shards', 'live-demo.pid'), String(process.pid));
  const url = `http://127.0.0.1:${actual}/`;
  console.log(`[live-demo] control panel: ${url}`);
  console.log('[live-demo] demo ledger: demo/seen-numbers-demo.json · channel: off (admin chat only)');
  if (shouldOpen) openBrowser(url);
});

server.listen(listenPort, '127.0.0.1');

process.on('SIGINT', () => {
  try {
    stopAll();
  } catch {
    // best effort
  }
  process.exit(0);
});
