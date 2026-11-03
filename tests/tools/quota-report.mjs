#!/usr/bin/env node
// quota-report.mjs
// Turns a new ADSL remaining-quota reading into a verdict about whether the
// per-shard browser cache is actually saving data.
//
//   node tests/tools/quota-report.mjs --remaining 19.20
//   node tests/tools/quota-report.mjs --remaining 19.20 --baseline metrics/adsl-baseline-2026-10-31T0143Z.json
//
// Inputs:
//   metrics/adsl-baseline-*.json   quota, adapter bytes and log counters at T0
//   metrics/net-samples.csv        adapter bytes sampled every 5 minutes
//   logs/*.log                     cumulative account counters
//   screenshots/**                 upload volume (Telegram sends one image per hit)
//
// Output: a printed table plus metrics/quota-report-<ts>.json.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(process.cwd());
const arg = (name) => {
  const withEq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return null;
};

const remainingArg = arg('remaining');
if (remainingArg === null) {
  console.error('usage: node tests/tools/quota-report.mjs --remaining <GB> [--baseline <file>]');
  process.exit(1);
}
const remainingNow = Number(remainingArg);

function latestBaseline() {
  const dir = path.join(ROOT, 'metrics');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^adsl-baseline-.*\.json$/.test(f)).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

const baselinePath = arg('baseline') || latestBaseline();
if (!baselinePath || !existsSync(baselinePath)) {
  console.error('[quota] no baseline found');
  process.exit(1);
}
const base = JSON.parse(readFileSync(baselinePath, 'utf8'));

const logCount = (file, needle) => {
  const full = path.join(ROOT, file);
  if (!existsSync(full)) return 0;
  let n = 0;
  for (const line of readFileSync(full, 'utf8').split('\n')) if (line.includes(needle)) n += 1;
  return n;
};

const dirBytes = (dir) => {
  const full = path.resolve(ROOT, dir);
  if (!existsSync(full)) return 0;
  let total = 0;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const p = path.join(full, entry.name);
    if (entry.isDirectory()) total += dirBytes(path.join(dir, entry.name));
    else total += statSync(p).size;
  }
  return total;
};

// Screenshots captured since the baseline = what Telegram uploaded.
const filesSince = (dir, since) => {
  const full = path.resolve(ROOT, dir);
  if (!existsSync(full)) return { count: 0, bytes: 0 };
  let count = 0, bytes = 0;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const p = path.join(full, entry.name);
    if (entry.isDirectory()) {
      const sub = filesSince(path.join(dir, entry.name), since);
      count += sub.count; bytes += sub.bytes;
    } else {
      const st = statSync(p);
      if (st.mtimeMs > since) { count += 1; bytes += st.size; }
    }
  }
  return { count, bytes };
};

// Adapter totals from the last sample.
const csvPath = path.join(ROOT, 'metrics', 'net-samples.csv');
let adapter = null;
if (existsSync(csvPath)) {
  const rows = readFileSync(csvPath, 'utf8').trim().split('\n').slice(1);
  if (rows.length) {
    const last = rows[rows.length - 1].split(',');
    adapter = { ts: last[0], rx: Number(last[1]), tx: Number(last[2]), cache1: Number(last[8]) };
  }
}

const sinceMs = new Date(base.captured_at_utc).getTime();

const s1 = logCount('logs/shard-1.log', 'success for');
const s2 = logCount('logs/shard-2.log', 'success for');
const mel = logCount('logs/melbet.log', 'Signing in with');

const n1 = Math.max(0, s1 - base.workload_counters.shard1_success_total);
const n2 = Math.max(0, s2 - base.workload_counters.shard2_success_total);
const nmel = Math.max(0, mel - base.workload_counters.melbet_accounts_started);
const n1x = n1 + n2;

const shots1x = filesSince('screenshots/shard-1', sinceMs);
const shots2x = filesSince('screenshots/shard-2', sinceMs);
const shotsMel = filesSince('C:/Users/Dell/Desktop/workspace/melbet-autologin/screenshots', sinceMs);

const COLD_MB = 8.10;
const WARM_MB = 0.53;

const predictedNewMb = n1x * WARM_MB;
const oldIfShard1Starved = n1 * COLD_MB + n2 * WARM_MB;
const oldIfShard2Starved = n2 * COLD_MB + n1 * WARM_MB;
const oldLow = Math.min(oldIfShard1Starved, oldIfShard2Starved);
const oldHigh = Math.max(oldIfShard1Starved, oldIfShard2Starved);

const deltaQuotaGb = base.quota.remaining_gb - remainingNow;
const adapterDeltaGb = adapter
  ? ((adapter.rx + adapter.tx) - (base.machine_counters.rx_bytes + base.machine_counters.tx_bytes)) / 1073741824
  : null;

const uploadMb = (shots1x.bytes + shots2x.bytes + shotsMel.bytes) / 1048576;
const cacheReset = adapter && adapter.cache1 < 5 ? 'POSSIBLE (shard-1 cache near 0 MB)' : 'no';

const gb = (mb) => (mb / 1024).toFixed(2);

console.log('');
console.log('  ADSL / BROWSER DATA CHECK');
console.log('  ----------------------------------------------------------------');
console.log(`  baseline            ${base.captured_at_local}  (${base.quota.remaining_gb} GB left)`);
console.log(`  now                 ${new Date().toISOString()}  (${remainingNow} GB left)`);
console.log('');
console.log(`  quota consumed      ${deltaQuotaGb.toFixed(2)} GB`);
console.log(`  adapter consumed    ${adapterDeltaGb === null ? 'n/a' : adapterDeltaGb.toFixed(2) + ' GB'}  (rx+tx, this machine)`);
console.log('');
console.log(`  accounts processed  shard-1 ${n1}, shard-2 ${n2}, melbet ${nmel}  (1xbet total ${n1x})`);
console.log(`  screenshots         ${shots1x.count + shots2x.count + shotsMel.count} files, ${uploadMb.toFixed(1)} MB to upload`);
console.log('');
console.log('  1xbet browsing prediction for this workload');
console.log(`    with the fix       ${gb(predictedNewMb)} GB`);
console.log(`    without the fix    ${gb(oldLow)} - ${gb(oldHigh)} GB  (one shard starved)`);
console.log('');
if (adapterDeltaGb !== null) {
  const residualMb = (adapterDeltaGb * 1024) - predictedNewMb - uploadMb;
  console.log(`  unexplained after subtracting 1xbet+uploads: ${residualMb.toFixed(0)} MB (melbet, sync, OS)`);
  const allAccounts = n1x + nmel;
  console.log(`  per account, all sources (adapter): ${allAccounts ? ((adapterDeltaGb * 1024) / allAccounts).toFixed(2) : 'n/a'} MB`);
}
console.log(`  shard-1 cache now   ${adapter ? adapter.cache1 + ' MB' : 'n/a'}  (reset: ${cacheReset})`);
console.log('');

const verdict =
  n1x + nmel < 50 ? 'TOO EARLY (needs a meaningful window)'
  : adapterDeltaGb === null ? 'INCONCLUSIVE (no samples)'
  : adapterDeltaGb < (oldLow / 1024) * 0.6 ? 'CONSISTENT WITH THE FIX'
  : adapterDeltaGb < (oldHigh / 1024) * 0.85 ? 'PARTIAL / NEEDS EXPLANATION'
  : 'CONSISTENT WITH NO SAVING';
console.log(`  verdict             ${verdict}`);
console.log('');

const out = path.join(ROOT, 'metrics', `quota-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({
  baseline: base.captured_at_local,
  now: new Date().toISOString(),
  quota_remaining_gb: remainingNow,
  delta_quota_gb: deltaQuotaGb,
  delta_adapter_gb: adapterDeltaGb,
  accounts: { shard1: n1, shard2: n2, melbet: nmel, onexbet_total: n1x },
  screenshots: { count: shots1x.count + shots2x.count + shotsMel.count, upload_mb: uploadMb },
  prediction_new_gb: predictedNewMb / 1024,
  prediction_old_gb: [oldLow / 1024, oldHigh / 1024],
  verdict
}, null, 2));
console.log(`  saved ${out}`);
