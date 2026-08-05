#!/usr/bin/env node
// Emit this VM's system stats as JSON for the /status bot.
// Called by scripts/push-to-collector.sh before the rsync so the collector VM
// can show the other VM's RAM/load/disk/uptime in its /status reply.
//
// Env:
//   SYSTEM_STATS_FILE  output path (default ./system-stats.json)
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { hostname } from 'os';
import path from 'path';

const out = path.resolve(process.cwd(), process.env.SYSTEM_STATS_FILE || 'system-stats.json');

const info = readFileSync('/proc/meminfo', 'utf8').split('\n');
const get = (k) => {
  const line = info.find((l) => l.startsWith(k));
  return line ? parseInt(line.split(/\s+/)[1], 10) / 1024 : 0;
};
const totalMB = Math.round(get('MemTotal'));
const usedMB = Math.round(totalMB - get('MemAvailable'));

const load = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)[0];

const disk = execSync("df -h / | awk 'NR==2{print $5}'", { encoding: 'utf8' }).trim();
const up = execSync('uptime -p', { encoding: 'utf8' }).trim();

writeFileSync(
  out,
  JSON.stringify({ host: hostname(), usedMB, totalMB, load, disk, up }, null, 2)
);
console.log(`system-stats written: ${out} (${usedMB}/${totalMB} MB)`);
