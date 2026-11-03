import { exec } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import path from 'path';

export function sh(cmd, timeoutMs = 4000) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => {
      resolve((stdout ?? '').trim() || 'n/a');
    });
  });
}

export function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadAppDefs() {
  // 1. Try JSON file (avoids env var truncation for long values)
  const jsonPath = process.env.APP_DEFS_FILE || '/opt/1xauto/app-defs.json';
  try {
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
    if (Array.isArray(data)) return data;
  } catch {
    // fall through
  }
  // 2. Try env var (backward compat)
  if (process.env.APP_DEFS_JSON) {
    try {
      const parsed = JSON.parse(process.env.APP_DEFS_JSON);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to defaults
    }
  }
  return defaultAppDefs();
}

function defaultAppDefs() {
  return [
    {
      name: '1xauto',
      dir: '/opt/1xauto',
      group: 'A',
      services: ['1xauto-shard-1', '1xauto-shard-2'],
      shards: [
        {
          service: '1xauto-shard-1',
          startIndex: 1,
          endIndex: 69,
          stateFile: 'state-shard-1.json',
          summaryFile: 'run-summary-shard-1.json',
          screenshotsDir: 'screenshots/shard-1',
          loopStatusFile: 'loop-status-shard-1.json'
        },
        {
          service: '1xauto-shard-2',
          startIndex: 70,
          endIndex: 138,
          stateFile: 'state-shard-2.json',
          summaryFile: 'run-summary-shard-2.json',
          screenshotsDir: 'screenshots/shard-2',
          loopStatusFile: 'loop-status-shard-2.json'
        }
      ],
      seenNumbersFile: 'seen-numbers.json',
      logFilter: 'account=|state'
    },
  {
    name: 'linebet',
    dir: '/opt/linebet',
    group: 'B',
    services: [],
    shards: [
      {
        service: 'linebet',
        remote: true,
        startIndex: 1,
        endIndex: 44,
        stateFile: 'state-shard-1.json',
        summaryFile: 'run-summary-shard-1.json',
        screenshotsDir: 'screenshots',
        loopStatusFile: 'loop-status-shard-1.json'
      }
    ],
    seenNumbersFile: 'seen-numbers.json',
    logFilter: 'Signing in|Screenshot saved|Failed for|Loaded|Extracted'
  },
  {
    name: 'melbet',
    dir: '/opt/melbet',
    group: 'B',
    services: [],
    shards: [
      {
        service: 'melbet',
        remote: true,
        startIndex: 1,
        endIndex: 92,
        stateFile: 'state-shard-1.json',
        summaryFile: 'run-summary-shard-1.json',
        screenshotsDir: 'screenshots',
        loopStatusFile: 'loop-status-shard-1.json'
      }
    ],
    seenNumbersFile: 'seen-numbers.json',
    logFilter: 'Signing in|Screenshot saved|Failed for|Loaded|Extracted'
  }
  ];
}

export const APP_DEFS = loadAppDefs();

const ALERT_THRESHOLD_DISK = 85;
const ALERT_THRESHOLD_RAM = 85;

function fmtPct(used, total) {
  if (total <= 0) return '?';
  return `${Math.round((used / total) * 100)}%`;
}

function fmtMB(usedMB, totalMB) {
  const pct = fmtPct(usedMB, totalMB);
  return `${Math.round(usedMB)}/${Math.round(totalMB)} MB (${pct})`;
}

function cleanUp(up) {
  return (up || '').replace(/^up\s+/i, '').trim() || 'n/a';
}

function alertIcon(pct) {
  if (typeof pct === 'string') pct = parseInt(pct, 10);
  if (isNaN(pct)) return '';
  if (pct >= 95) return ' !!';
  if (pct >= ALERT_THRESHOLD_DISK) return ' !';
  return '';
}

function shortTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  if (ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m ago';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${mins % 60 ? `${mins % 60}m` : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d${hrs % 24 ? `${hrs % 24}h` : ''} ago`;
}

function withinShard(current, startIndex) {
  return current - startIndex + 1;
}

function diskPctNum(diskStr) {
  if (!diskStr) return 0;
  const m = String(diskStr).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function renderSystem(appDir = process.cwd()) {
  let m;
  try {
    const info = readFileSync('/proc/meminfo', 'utf8').split('\n');
    const get = (k) => {
      const line = info.find((l) => l.startsWith(k));
      return line ? parseInt(line.split(/\s+/)[1], 10) / 1024 : 0;
    };
    m = { totalMB: get('MemTotal'), availableMB: get('MemAvailable') };
    m.usedMB = m.totalMB - m.availableMB;
  } catch {
    m = { totalMB: 0, usedMB: 0 };
  }

  let load = 'n/a';
  try {
    load = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)[0];
  } catch {
    // leave n/a
  }

  const [disk, up] = await Promise.all([
    sh("df -h / | awk 'NR==2{print $5}'"),
    sh('uptime -p')
  ]);

  const localDiskPct = diskPctNum(disk);
  const localRamPct = Math.round((m.usedMB / m.totalMB) * 100);
  const localDiskAlert = alertIcon(localDiskPct);
  const localRamAlert = localRamPct >= ALERT_THRESHOLD_RAM ? ' !' : '';

  const lines = [];
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  lines.push(`=== VMs (${now}) ===`);
  lines.push(
    `  ${hostname().padEnd(20)} RAM ${fmtMB(m.usedMB, m.totalMB)}${localRamAlert}  load ${load}  disk ${disk}${localDiskAlert}  up ${cleanUp(up)}`
  );

  // 1xbetshards (remote)
  const remote = readJson(path.join(appDir, 'system-stats-remote.json'));
  if (remote && remote.totalMB > 0) {
    const rDiskPct = diskPctNum(remote.disk);
    const rRamPct = Math.round((remote.usedMB / remote.totalMB) * 100);
    const rDiskAlert = alertIcon(rDiskPct);
    const rRamAlert = rRamPct >= ALERT_THRESHOLD_RAM ? ' !' : '';
    lines.push(
      `  ${(remote.host ?? '1xbetshards').padEnd(20)} RAM ${fmtMB(remote.usedMB, remote.totalMB)}${rRamAlert}  load ${remote.load ?? 'n/a'}  disk ${remote.disk ?? 'n/a'}${rDiskAlert}  up ${cleanUp(remote.up)}`
    );
  } else {
    lines.push('  1xbetshards           (no stats — waiting for push)');
  }

  // linebet VM (remote)
  const linebetStats = readJson('/opt/linebet/system-stats.json');
  if (linebetStats && linebetStats.totalMB > 0) {
    const lDiskPct = diskPctNum(linebetStats.disk);
    const lRamPct = Math.round((linebetStats.usedMB / linebetStats.totalMB) * 100);
    const lDiskAlert = alertIcon(lDiskPct);
    const lRamAlert = lRamPct >= ALERT_THRESHOLD_RAM ? ' !' : '';
    const conductorTag = linebetStats.conductor === 'active' ? '' : ` cond:${linebetStats.conductor}`;
    lines.push(
      `  ${(linebetStats.host ?? 'linebet').padEnd(20)} RAM ${fmtMB(linebetStats.usedMB, linebetStats.totalMB)}${lRamAlert}  load ${linebetStats.load ?? 'n/a'}  disk ${linebetStats.disk ?? 'n/a'}${lDiskAlert}  up ${cleanUp(linebetStats.up)}${conductorTag}`
    );
  } else {
    lines.push('  linebet               (no stats — waiting for push)');
  }

  return lines.join('\n');
}

async function renderInfrastructure(appDir = process.cwd()) {
  const lines = [];
  lines.push('\n=== Infrastructure ===');

  // tri-farm conductor
  const linebetStats = readJson('/opt/linebet/system-stats.json');
  const conductorState = linebetStats?.conductor ?? 'unknown';
  const conductorIcon = conductorState === 'active' ? '+' : 'x';
  const lastSlot = linebetStats?.conductorLog?.match(/\[(.+?)\]\s*\[(.+?)\]/);
  const conductorDetail = conductorState === 'active' && lastSlot ? ` (last: ${lastSlot[2]})` : '';
  lines.push(`  tri-farm conductor     [${conductorIcon}] ${conductorState}${conductorDetail}`);

  // 1xauto collector
  const collectorState = await sh('systemctl is-active 1xauto-collector');
  const collectorIcon = collectorState === 'active' ? '+' : 'x';
  const collectState = readJson(path.join(appDir, 'collect-state.json'));
  const lastCollected = collectState?.lastCollectedAt ? timeAgo(new Date(collectState.lastCollectedAt).toISOString()) : null;
  lines.push(`  1xauto collector       [${collectorIcon}] ${collectorState}${lastCollected ? ` (last: ${lastCollected})` : ''}`);

  return lines.join('\n');
}

const PROGRESS_RE = /\[(\d+)\/(\d+)\]/;
const FAILURE_RE = /failed for (\S+): (.+)$|Failed for (\S+): (.+)$/i;

function parseLogs(raw) {
  const lines = raw.split('\n').filter(Boolean);
  let progress = null;
  let lastError = null;
  let failCount = 0;
  for (const line of lines) {
    const p = line.match(PROGRESS_RE);
    if (p) progress = { current: Number(p[1]), total: Number(p[2]) };
    const f = line.match(FAILURE_RE);
    if (f) {
      failCount++;
      const email = f[1] || f[3];
      const reason = f[2] || f[4];
      if (email) lastError = { email, reason };
    }
  }
  return { progress, lastError, failCount };
}

async function renderApp(def) {
  const serviceStates = await Promise.all(
    def.services.map((service) => sh(`systemctl is-active ${service}`))
  );

  const logTexts = await Promise.all(
    def.shards.map(async (s) => {
      if (s.remote) {
        try {
          const logName = (s.loopStatusFile || '').replace('loop-status-shard-', 'loop-log-shard-').replace('.json', '.txt');
          return readFileSync(path.join(def.dir, logName), 'utf8');
        } catch {
          return 'n/a';
        }
      }
      return sh(`journalctl -u ${s.service} --no-pager -n 60 2>/dev/null`);
    })
  );

  const seen = readJson(path.join(def.dir, def.seenNumbersFile));
  const lines = [];
  const uniqueCount = Array.isArray(seen?.numbers) ? seen.numbers.length : 0;
  const totalAccounts = def.shards.reduce((sum, s) => {
    if (s.startIndex && s.endIndex) return sum + (s.endIndex - s.startIndex + 1);
    return sum;
  }, 0);
  lines.push(`\n=== ${def.name} (group ${def.group ?? '?'})${uniqueCount ? ` · ${uniqueCount} unique` : ''}${totalAccounts ? ` · ${totalAccounts} accs` : ''} ===`);

  def.shards.forEach((s, i) => {
    const loop = readJson(path.join(def.dir, s.loopStatusFile));
    const st = readJson(path.join(def.dir, s.stateFile));
    const sum = readJson(path.join(def.dir, s.summaryFile));
    const serviceActive = serviceStates[i] === 'active';
    const local = s.remote ? true : serviceActive;
    const isRunning = local && loop?.state === 'running';
    const { progress, lastError, failCount } = parseLogs(logTexts[i] || 'n/a');

    const startIndex = s.startIndex ?? loop?.startIndex ?? 1;
    const endIndex = s.endIndex ?? null;
    const shardTotal = endIndex ? endIndex - startIndex + 1 : null;

    let stateLabel;
    if (s.remote) {
      if (loop?.state === 'running') stateLabel = 'active';
      else if (loop?.state === 'done') stateLabel = 'done';
      else if (loop?.state === 'failed') stateLabel = 'FAILED';
      else stateLabel = loop?.state ?? 'no data';
    } else if (!serviceActive) {
      stateLabel = 'STOPPED';
    } else if (isRunning) {
      stateLabel = 'active';
    } else {
      stateLabel = loop?.state ?? 'starting';
    }

    const stateIcon = stateLabel === 'active' ? '+' : stateLabel === 'FAILED' ? '!' : stateLabel === 'STOPPED' ? 'x' : 'o';

    const nameCol = `shard-${(i + 1)}`.padEnd(10);
    const stateCol = `[${stateIcon}] ${stateLabel}`.padEnd(14);
    const bits = [];
    if (isRunning && progress?.current) {
      const within = withinShard(progress.current, startIndex);
      bits.push(`acc ${within}${shardTotal ? `/${shardTotal}` : ''}`);
    } else if (loop?.state === 'cooldown' && loop.nextRunAt) {
      bits.push(`next ${shortTime(loop.nextRunAt)}`);
    } else if (loop?.state === 'done') {
      if (loop.durationMs) {
        const dur = Math.round(loop.durationMs / 1000);
        bits.push(dur >= 3600 ? `${(dur / 3600).toFixed(1)}h` : `${Math.round(dur / 60)}m`);
      } else if (loop.finishedAt) {
        bits.push(timeAgo(loop.finishedAt) ?? '');
      }
    }
    if (st && st.lastProcessedIndex != null) {
      const last = withinShard(st.lastProcessedIndex, startIndex);
      if (last > 0) bits.push(`last ${last}`);
    }
    if (sum) {
      const ok = sum.succeeded || 0;
      const err = sum.failed || 0;
      if (ok || err) {
        bits.push(`${ok} ok, ${err} err`);
      } else if (typeof sum.ok === 'boolean') {
        bits.push(sum.ok ? 'ok' : 'err');
      }
    }
    lines.push(`  ${nameCol} ${stateCol} ${bits.join(' · ')}`);

    if (lastError && failCount > 0) {
      const reason = (lastError.reason || '').slice(0, 80);
      lines.push(`            (${failCount} err) last: ${lastError.email}${reason ? ` — ${reason}` : ''}`);
    }
  });

  return lines.join('\n');
}

export async function buildStatusText({ appDir = process.cwd(), apps = null } = {}) {
  const targets = apps || (() => {
    const base = path.basename(appDir);
    return [APP_DEFS.find((d) => d.name === base) || APP_DEFS[0]];
  })();
  const [system, infra, ...appParts] = await Promise.all([
    renderSystem(appDir),
    renderInfrastructure(appDir),
    ...targets.map((app) => renderApp(app))
  ]);
  return [system, infra, ...appParts].join('\n').trim();
}

export async function buildAllStatusText() {
  const appDir = APP_DEFS[0]?.dir ?? process.cwd();
  const [system, infra, ...appParts] = await Promise.all([
    renderSystem(appDir),
    renderInfrastructure(appDir),
    ...APP_DEFS.map((app) => renderApp(app))
  ]);
  return [system, infra, ...appParts].join('\n').trim();
}
