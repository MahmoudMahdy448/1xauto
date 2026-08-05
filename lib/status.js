import { exec } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
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

export const APP_DEFS = [
  {
    name: '1xauto',
    dir: '/opt/1xauto',
    group: 'A',
    services: ['1xauto-shard-1', '1xauto-shard-2'],
    shards: [
      {
        service: '1xauto-shard-1',
        stateFile: 'state-shard-1.json',
        summaryFile: 'run-summary-shard-1.json',
        screenshotsDir: 'screenshots/shard-1',
        loopStatusFile: 'loop-status-shard-1.json'
      },
      {
        service: '1xauto-shard-2',
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

function countFiles(dir) {
  if (!existsSync(dir)) {
    return '0';
  }
  try {
    return String(readdirSync(dir).length);
  } catch {
    return '0';
  }
}

async function renderSystem() {
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

  const [disk, uptime] = await Promise.all([
    sh("df -h / | awk 'NR==2{print $5}'"),
    sh('uptime -p')
  ]);

  return `System: RAM ${Math.round(m.usedMB)}/${Math.round(m.totalMB)}MB, load ${load}, disk ${disk}, up ${uptime}`;
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
    if (f) lastError = f[1] || f[3] ? `${f[1] || f[3]}: ${f[2] || f[4]}` : null;
  }
  return { progress, lastError };
}

function shortTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function loopSummary(loopStatus, serviceActive) {
  if (!loopStatus) return null;
  if (!serviceActive) {
    return 'stopped';
  }
  if (loopStatus.state === 'cooldown') {
    return `cooldown, next ~${shortTime(loopStatus.nextRunAt) || '?'}`;
  }
  if (loopStatus.state === 'running') {
    return 'running now';
  }
  if (loopStatus.state === 'waiting') {
    return 'waiting for turn';
  }
  return 'starting';
}

async function renderApp(def) {
  const serviceStates = await Promise.all(
    def.services.map((service) => sh(`systemctl is-active ${service}`))
  );

  const logTexts = await Promise.all(
    def.shards.map((s) =>
      sh(`journalctl -u ${s.service} --no-pager -n 40 2>/dev/null`)
    )
  );

  const seen = readJson(path.join(def.dir, def.seenNumbersFile));
  const lines = [];
  lines.push(`\n=== ${def.name} (group ${def.group ?? '?'}) ===`);

  def.shards.forEach((s, i) => {
    const loop = readJson(path.join(def.dir, s.loopStatusFile));
    const st = readJson(path.join(def.dir, s.stateFile));
    const sum = readJson(path.join(def.dir, s.summaryFile));
    const shots = countFiles(path.join(def.dir, s.screenshotsDir));
    const serviceActive = serviceStates[i] === 'active';
    const isRunning = serviceActive && loop?.state === 'running';
    const { progress, lastError } = parseLogs(logTexts[i] || 'n/a');

    const stateLabel = serviceStates[i] === 'active' ? 'active' : serviceStates[i];
    const progressLabel = isRunning && progress ? `${progress.current}/${progress.total}` : '-';

    lines.push(`${s.service}: ${stateLabel}, progress ${progressLabel}, screenshots ${shots}`);
    if (st && isRunning) lines.push(`  last processed: ${st.lastProcessedIndex}`);
    if (loop) lines.push(`  ${loopSummary(loop, serviceActive)}`);
    if (sum && isRunning) lines.push(`  last run: ok=${sum.succeeded} fail=${sum.failed}`);
    if (lastError && isRunning) lines.push(`  last error: ${lastError}`);
  });

  lines.push(`unique numbers: ${seen?.numbers?.length ?? 0}`);

  return lines.join('\n');
}

export async function buildStatusText({ appDir = process.cwd(), apps = null } = {}) {
  const targets = apps || (() => {
    const base = path.basename(appDir);
    return [APP_DEFS.find((d) => d.name === base) || APP_DEFS[0]];
  })();
  const [system, ...appParts] = await Promise.all([
    renderSystem(),
    ...targets.map((app) => renderApp(app))
  ]);
  return [system, ...appParts].join('\n').trim();
}

export async function buildAllStatusText() {
  const [system, ...appParts] = await Promise.all([
    renderSystem(),
    ...APP_DEFS.map((app) => renderApp(app))
  ]);
  return [system, ...appParts].join('\n').trim();
}
