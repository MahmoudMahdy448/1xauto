#!/usr/bin/env node
// Evidence guard — proves that a code change does not alter the evidence
// screenshot, and measures what each account actually downloads.
//
// It runs the real login flow on a small fixed set of accounts with every
// writable path redirected into evidence-guard/<label>/, so production state,
// summaries, screenshots, events and the ledger are untouched.
//
//   node tests/tools/evidence-guard.mjs run cold   [cacheDir]
//   node tests/tools/evidence-guard.mjs run warm   <cacheDir>
//   node tests/tools/evidence-guard.mjs diff cold warm
//
// `run cold` with a fresh cacheDir downloads everything once. `run warm` against
// the same cacheDir reuses it — which is exactly what a shard does after the
// per-shard cache fix. `diff` compares the two runs pixel by pixel in Chromium
// (no image libraries needed) and ignores nothing: it reports every pixel that
// changed, so we decide what is natural (the site's clock) and what is not.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = path.resolve(process.cwd());
const GUARD_ROOT = path.join(ROOT, 'evidence-guard');
const GUARD_CSV = path.join(ROOT, 'tests', 'tools', 'guard-accounts.csv');
const [mode, a, b] = process.argv.slice(2);

function fail(message) {
  console.error(`[guard] ${message}`);
  process.exit(1);
}

function assertFarmStopped() {
  const pidDir = path.join(ROOT, 'shards');
  if (!existsSync(pidDir)) return;
  const pids = readdirSync(pidDir).filter((f) => f.endsWith('.pid'));
  if (pids.length > 0) {
    fail(`farm is running (${pids.join(', ')}). Run stop-all.bat first — the guard must not share state with a live pass.`);
  }
}

function runDir(label) {
  return path.join(GUARD_ROOT, label);
}

async function run(label, cacheDirArg) {
  if (!label) fail('usage: run <label> [cacheDir]');
  assertFarmStopped();
  if (!existsSync(GUARD_CSV)) fail(`missing ${GUARD_CSV}`);

  const dir = runDir(label);
  if (existsSync(dir)) fail(`${label} already exists — remove it or use another label`);

  const shots = path.join(dir, 'screenshots');
  const cacheDir = cacheDirArg ? path.resolve(cacheDirArg) : path.join(dir, '.browser-cache');
  mkdirSync(shots, { recursive: true });

  const accounts = readFileSync(GUARD_CSV, 'utf8').trim().split('\n').length - 1;

  const env = {
    ...process.env,
    ACCOUNTS_FILE: GUARD_CSV,
    STATE_FILE: path.join(dir, 'state.json'),
    RUN_SUMMARY_FILE: path.join(dir, 'run-summary.json'),
    SCREENSHOTS_DIR: shots,
    EVENTS_DIR: path.join(dir, 'events'),
    METRICS_DIR: path.join(dir, 'metrics'),
    FAILURES_LOG_FILE: path.join(dir, 'logs', 'failed-accounts.log'),
    ERROR_SCREENSHOTS_DIR: path.join(dir, 'screenshots', 'errors'),
    DEBUG_SCREENSHOTS_DIR: path.join(dir, 'screenshots', 'debug'),
    BROWSER_CACHE_DIR: cacheDir,
    NET_METRICS: 'true',
    START_INDEX: '1',
    END_INDEX: String(accounts),
    HEADLESS: 'true',
    SKIP_NOTIFY: 'true'
  };

  writeFileSync(
    path.join(dir, 'run.json'),
    JSON.stringify({ label, cacheDir, accounts, startedAt: new Date().toISOString() }, null, 2)
  );

  console.log(`[guard] ${label}: ${accounts} account(s), cache ${cacheDir}`);
  const started = Date.now();
  const child = spawn('npx', ['playwright', 'test', 'tests/login.spec.js', '--workers=1', '--reporter=line'], {
    stdio: 'inherit',
    env,
    cwd: ROOT,
    shell: true
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  const pngs = readdirSync(shots).filter((f) => f.endsWith('.png')).sort();
  const evidence = pngs.map((file) => {
    const full = path.join(shots, file);
    return {
      file,
      bytes: statSync(full).size,
      sha256: createHash('sha256').update(readFileSync(full)).digest('hex')
    };
  });

  let metrics = [];
  const metricsDir = path.join(dir, 'metrics');
  if (existsSync(metricsDir)) {
    for (const f of readdirSync(metricsDir)) {
      const text = readFileSync(path.join(metricsDir, f), 'utf8').trim();
      if (!text) continue;
      metrics = metrics.concat(text.split('\n').map((line) => JSON.parse(line)));
    }
  }

  writeFileSync(
    path.join(dir, 'evidence.json'),
    JSON.stringify({ label, exitCode: code, seconds, screenshots: evidence, metrics }, null, 2)
  );

  console.log(`[guard] ${label}: exit ${code}, ${pngs.length} screenshot(s), ${seconds}s`);
  for (const m of metrics) {
    console.log(`[guard]   ${m.account} · ${m.totalMB} MB · ${m.requestCount} req · cache ${Math.round(m.cacheHitRate * 100)}% · ` +
      Object.entries(m.byPhase).map(([p, v]) => `${p} ${(v.bytes / 1048576).toFixed(2)}MB`).join(' '));
  }
  if (code !== 0) fail(`playwright failed for ${label} — see the output above`);
}

async function diff(labelA, labelB) {
  if (!labelA || !labelB) fail('usage: diff <labelA> <labelB>');
  const dirA = runDir(labelA);
  const dirB = runDir(labelB);
  for (const d of [dirA, dirB]) if (!existsSync(d)) fail(`missing ${d}`);

  const shotsA = readdirSync(path.join(dirA, 'screenshots')).filter((f) => f.endsWith('.png')).sort();
  const shotsB = readdirSync(path.join(dirB, 'screenshots')).filter((f) => f.endsWith('.png')).sort();

  if (shotsA.length !== shotsB.length) {
    fail(`different screenshot counts: ${shotsA.length} vs ${shotsB.length}`);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const results = [];
  for (let i = 0; i < shotsA.length; i += 1) {
    const fileA = path.join(dirA, 'screenshots', shotsA[i]);
    const fileB = path.join(dirB, 'screenshots', shotsB[i]);
    const dataA = 'data:image/png;base64,' + readFileSync(fileA).toString('base64');
    const dataB = 'data:image/png;base64,' + readFileSync(fileB).toString('base64');

    const result = await page.evaluate(async ([srcA, srcB]) => {
      const load = (src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
      const [imgA, imgB] = await Promise.all([load(srcA), load(srcB)]);
      if (imgA.naturalWidth !== imgB.naturalWidth || imgA.naturalHeight !== imgB.naturalHeight) {
        return { sizeMismatch: true, a: [imgA.naturalWidth, imgA.naturalHeight], b: [imgB.naturalWidth, imgB.naturalHeight] };
      }
      const w = imgA.naturalWidth;
      const h = imgA.naturalHeight;
      const canvas = (img) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.getContext('2d').getImageData(0, 0, w, h).data;
      };
      const px = canvas(imgA);
      const py = canvas(imgB);

      let differing = 0;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      let maxDelta = 0;
      // Row/column histograms tell us whether differences are a small region
      // (the header clock) or spread across the whole page (a real change).
      const rows = new Array(h).fill(0);
      const cols = new Array(w).fill(0);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const i4 = (y * w + x) * 4;
          const d = Math.abs(px[i4] - py[i4]) + Math.abs(px[i4 + 1] - py[i4 + 1]) + Math.abs(px[i4 + 2] - py[i4 + 2]);
          if (d === 0) continue;
          differing += 1;
          rows[y] += 1;
          cols[x] += 1;
          if (d > maxDelta) maxDelta = d;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }

      // Contiguous bands of changed rows, so a clock or a video frame shows up
      // as its own rectangle instead of one page-sized box.
      const bands = [];
      let open = null;
      for (let y = 0; y < h; y += 1) {
        const changed = rows[y] > 0;
        if (changed && !open) open = { top: y, bottom: y };
        else if (changed && open) open.bottom = y;
        else if (!changed && open) { bands.push(open); open = null; }
      }
      if (open) bands.push(open);

      return {
        sizeMismatch: false,
        width: w,
        height: h,
        differing,
        percent: +((differing / (w * h)) * 100).toFixed(4),
        maxDelta,
        box: differing ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
        bands: bands.map((b) => ({ top: b.top, bottom: b.bottom, height: b.bottom - b.top + 1 })),
        changedColumns: cols.filter((c) => c > 0).length
      };
    }, [dataA, dataB]);

    results.push({ a: shotsA[i], b: shotsB[i], ...result });
  }

  await browser.close();

  const out = path.join(GUARD_ROOT, `diff-${labelA}-vs-${labelB}.json`);
  writeFileSync(out, JSON.stringify(results, null, 2));

  console.log(`[guard] diff ${labelA} vs ${labelB}`);
  for (const r of results) {
    if (r.sizeMismatch) {
      console.log(`  ${r.a}: SIZE MISMATCH ${r.a.join('x')} vs ${r.b.join('x')}`);
      continue;
    }
    console.log(`  ${r.a}: ${r.differing} px differ (${r.percent}%), max delta ${r.maxDelta}`);
    if (r.box) console.log(`     box x${r.box.x} y${r.box.y} ${r.box.w}x${r.box.h}; bands ${JSON.stringify(r.bands)}`);
  }
  console.log(`[guard] written: ${out}`);
}

if (mode === 'run') await run(a, b);
else if (mode === 'diff') await diff(a, b);
else fail('usage: run <label> [cacheDir] | diff <labelA> <labelB>');
