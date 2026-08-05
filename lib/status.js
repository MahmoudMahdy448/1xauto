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

// APP_DEFS can be overridden for a VM via APP_DEFS_JSON (set on the status-bot
// unit) so a sharded-only VM doesn't show sibling sites that aren't present.
function loadAppDefs() {
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
          endIndex: 149,
          stateFile: 'state-shard-1.json',
          summaryFile: 'run-summary-shard-1.json',
          screenshotsDir: 'screenshots/shard-1',
          loopStatusFile: 'loop-status-shard-1.json'
        },
        {
          service: '1xauto-shard-2',
          startIndex: 150,
          endIndex: 276,
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
    services: ['linebet'],
    shards: [
      {
        service: 'linebet',
        stateFile: 'state.json',
        summaryFile: 'run-summary.json',
        screenshotsDir: 'screenshots',
        loopStatusFile: 'loop-status.json'
      }
    ],
    seenNumbersFile: 'seen-numbers.json',
    logFilter: 'Signing in|Screenshot saved|Failed for|Loaded|Extracted'
  },
  {
    name: 'melbet',
    dir: '/opt/melbet',
    group: 'B',
    services: ['melbet'],
    shards: [
      {
        service: 'melbet',
        stateFile: 'state.json',
        summaryFile: 'run-summary.json',
        screenshotsDir: 'screenshots',
        loopStatusFile: 'loop-status.json'
      }
    ],
    seenNumbersFile: 'seen-numbers.json',
    logFilter: 'Signing in|Screenshot saved|Failed for|Loaded|Extracted'
  }
  ];
}

export const APP_DEFS = loadAppDefs();

function fmtMB(usedMB, totalMB) {
  const pct = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;
  return `${Math.round(usedMB)}/${Math.round(totalMB)} MB (${pct}%)`;
}

function cleanUp(up) {
  return (up || '').replace(/^up\s+/i, '').trim() || 'n/a';
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

  const remote = readJson(path.join(appDir, 'system-stats-remote.json'));
  const lines = [];
  lines.push('=== System ===');
  lines.push(
    `Local VM (${hostname()}): RAM ${fmtMB(m.usedMB, m.totalMB)}, load ${load}, disk ${disk}, up ${cleanUp(up)}`
  );
  if (remote && remote.totalMB > 0) {
    lines.push(
      `Shard VM (${remote.host ?? '1xBetshards'}): RAM ${fmtMB(remote.usedMB, remote.totalMB)}, load ${remote.load ?? 'n/a'}, disk ${remote.disk ?? 'n/a'}, up ${cleanUp(remote.up)}`
    );
  } else {
    lines.push('Shard VM: no stats yet (waiting for the next push)');
  }
  return lines.join('\n');
}

const PROGRESS_RE = /\[(\d+)\/(\d+)\]/;
const FAILURE_RE = /failed for (\S+): (.+)$|Failed for (\S+): (.+)$/i;

function parseLogs(raw) {
  const lines = raw.split('\n').filter(Boolean);
  let progress = null;
  let lastError = null;
  for (const line of lines) {
    const p = line.match(PROGRESS_RE);
    if (p) progress = { current: Number(p[1]), total: Number(p[2]) };
    const f = line.match(FAILURE_RE);
    if (f) {
      const email = f[1] || f[3];
      const reason = f[2] || f[4];
      if (email) lastError = { email, reason };
    }
  }
  return { progress, lastError };
}

function shortTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function withinShard(current, startIndex) {
  return current - startIndex + 1;
}

async function renderApp(def) {
  const serviceStates = await Promise.all(
    def.services.map((service) => sh(`systemctl is-active ${service}`))
  );

  const logTexts = await Promise.all(
    def.shards.map(async (s) => {
      // Remote shards have no systemd unit on this VM — read the pushed log tail.
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
  lines.push(`\n=== ${def.name} (group ${def.group ?? '?'})${uniqueCount ? ` · ${uniqueCount} unique` : ''} ===`);

  def.shards.forEach((s, i) => {
    const loop = readJson(path.join(def.dir, s.loopStatusFile));
    const st = readJson(path.join(def.dir, s.stateFile));
    const sum = readJson(path.join(def.dir, s.summaryFile));
    const serviceActive = serviceStates[i] === 'active';
    // Remote shards (units on another VM) rely on the pushed loop-status file.
    const local = s.remote ? true : serviceActive;
    const isRunning = local && loop?.state === 'running';
    const { progress, lastError } = parseLogs(logTexts[i] || 'n/a');

    const startIndex = s.startIndex ?? loop?.startIndex ?? 1;
    const endIndex = s.endIndex ?? null;
    const shardTotal = endIndex ? endIndex - startIndex + 1 : null;

    let stateLabel;
    if (s.remote) {
      stateLabel = loop?.state === 'running' ? 'active' : (loop?.state ?? 'no status');
    } else if (!serviceActive) {
      stateLabel = 'stopped';
    } else if (isRunning) {
      stateLabel = 'active';
    } else {
      stateLabel = loop?.state ?? 'starting';
    }

    const nameCol = s.service.padEnd(12);
    const stateCol = stateLabel.padEnd(9);
    const bits = [];
    if (isRunning && progress?.current) {
      const within = withinShard(progress.current, startIndex);
      bits.push(`acc ${within}${shardTotal ? `/${shardTotal}` : ''}`);
    } else if (loop?.state === 'cooldown' && loop.nextRunAt) {
      bits.push(`next ${shortTime(loop.nextRunAt)}`);
    }
    if (st && st.lastProcessedIndex != null) {
      bits.push(`last ${withinShard(st.lastProcessedIndex, startIndex)}`);
    }
    if (sum) {
      bits.push(`run ${sum.succeeded} ok, ${sum.failed} err`);
    }
    lines.push(`${nameCol}${stateCol}${bits.join(' · ')}`);

    if (lastError) {
      const reason = (lastError.reason || '').slice(0, 90);
      lines.push(`             last error: ${lastError.email}${reason ? ` — ${reason}` : ''}`);
    }
  });

  return lines.join('\n');
}

export async function buildStatusText({ appDir = process.cwd(), apps = null } = {}) {
  const targets = apps || (() => {
    const base = path.basename(appDir);
    return [APP_DEFS.find((d) => d.name === base) || APP_DEFS[0]];
  })();
  const [system, ...appParts] = await Promise.all([
    renderSystem(appDir),
    ...targets.map((app) => renderApp(app))
  ]);
  return [system, ...appParts].join('\n').trim();
}

export async function buildAllStatusText() {
  const appDir = APP_DEFS[0]?.dir ?? process.cwd();
  const [system, ...appParts] = await Promise.all([
    renderSystem(appDir),
    ...APP_DEFS.map((app) => renderApp(app))
  ]);
  return [system, ...appParts].join('\n').trim();
}
