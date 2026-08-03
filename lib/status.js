import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

export function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return 'n/a';
  }
}

export function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function buildStatusText({ appDir = process.cwd() } = {}) {
  const SHARD_FILES = [1, 2].map((n) => ({
    service: `1xauto-shard-${n}`,
    stateFile: path.join(appDir, `state-shard-${n}.json`),
    summaryFile: path.join(appDir, `run-summary-shard-${n}.json`),
    screenshotsDir: path.join(appDir, 'screenshots', `shard-${n}`),
    loopStatusFile: path.join(appDir, `loop-status-shard-${n}.json`)
  }));
  const SEEN_NUMBERS_FILE = path.join(appDir, process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json');

  const lines = [];

  function section(title) {
    lines.push(`\n=== ${title} ===`);
  }

  // System
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

  let l = { one: 'n/a', five: 'n/a', fifteen: 'n/a' };
  try {
    const parts = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
    l = { one: parts[0], five: parts[1], fifteen: parts[2] };
  } catch {
    // leave n/a
  }

  section('System');
  lines.push(`RAM: ${Math.round(m.usedMB)} MB used / ${Math.round(m.totalMB)} MB total`);
  lines.push(`Load avg: ${l.one} (1m) ${l.five} (5m) ${l.fifteen} (15m)`);
  lines.push(`Disk /: ${sh("df -h / | awk 'NR==2{print $3\"/\"$2\" used (\"$5\")\"}'")}`);
  lines.push(`Uptime: ${sh('uptime -p')}`);

  // Services
  section('Services');
  for (const s of SHARD_FILES) {
    lines.push(`${s.service}: ${sh(`systemctl is-active ${s.service}`)}`);
  }

  // Loop
  section('Loop');
  for (const s of SHARD_FILES) {
    const loopStatus = readJson(s.loopStatusFile);
    if (loopStatus) {
      lines.push(`${s.service}: state=${loopStatus.state} run=#${loopStatus.run ?? '?'} startIndex=${loopStatus.startIndex} cooldown=${loopStatus.cooldownMinutes}min next=${loopStatus.nextRunAt ?? 'in progress'}`);
    } else {
      lines.push(`${s.service}: no loop-status file (run-loop.js not running?)`);
    }
  }

  // Ledger
  const seen = readJson(SEEN_NUMBERS_FILE);
  section('Unique numbers ledger');
  lines.push(`Total unique numbers reported: ${seen?.numbers?.length ?? 0}`);

  // Shards
  section('Shards');
  for (const s of SHARD_FILES) {
    const st = readJson(s.stateFile);
    const sum = readJson(s.summaryFile);
    const shots = existsSync(s.screenshotsDir)
      ? execSync(`ls ${s.screenshotsDir} | wc -l`, { encoding: 'utf8' }).trim()
      : '0';
    const processed = st ? st.lastProcessedIndex : '-';
    const lastRun = sum
      ? `run ${new Date(sum.batchId).toLocaleString()} — ok=${sum.succeeded} fail=${sum.failed}`
      : 'no summary yet';
    lines.push(`${s.service}: lastProcessedIndex=${processed} screenshots=${shots}`);
    lines.push(`  ${lastRun}`);
  }

  // Recent logs
  section('Recent log lines (shard 1)');
  lines.push(sh(`journalctl -u 1xauto-shard-1 --no-pager -n 8 2>/dev/null | grep -E 'account=|state' | tail -8`));
  section('Recent log lines (shard 2)');
  lines.push(sh(`journalctl -u 1xauto-shard-2 --no-pager -n 8 2>/dev/null | grep -E 'account=|state' | tail -8`));

  return lines.join('\n').trim();
}
