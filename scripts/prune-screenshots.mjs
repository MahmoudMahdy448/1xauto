// prune-screenshots.mjs
//
// One-off / manual version of the realtime sender's retention sweep, for
// clearing a backlog of already-delivered screenshots without waiting for the
// next batch to start a sender.
//
//   node scripts/prune-screenshots.mjs --dir screenshots/shard-1,screenshots/shard-2
//   node scripts/prune-screenshots.mjs --dir screenshots/shard-1 --dry-run
//   node scripts/prune-screenshots.mjs --dir . --ledger seen-numbers.json --older-than 60
//
// It uses exactly the same rules as the automatic sweep (lib/screenshot-retention.js):
// a file is deleted only when its number is in the ledger and the file is older
// than the window. Failed/unsent sends and unnumbered files are kept.

import { existsSync, statSync } from 'fs';
import path from 'path';
import { pruneSentScreenshots, screenshotRetentionMs } from '../lib/screenshot-retention.js';

const args = process.argv.slice(2);

function usage() {
  console.log(`Usage: node scripts/prune-screenshots.mjs [options]

  --dir <path>          screenshots dir; repeatable or comma-separated (required)
  --ledger <path>       ledger JSON (default: seen-numbers.json)
  --older-than <min>    retention window in minutes (default: SCREENSHOT_RETENTION_MS or 15)
  --dry-run             report what would be deleted, delete nothing
  --help                show this help`);
}

function fail(message) {
  console.error(`[prune-screenshots] ${message}`);
  process.exit(1);
}

const dirs = [];
let ledger = 'seen-numbers.json';
let retentionMs = screenshotRetentionMs();
let dryRun = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    usage();
    process.exit(0);
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--dir') {
    const value = args[i + 1];
    if (!value) fail('--dir needs a path');
    dirs.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
    i += 1;
  } else if (arg === '--ledger') {
    ledger = args[i + 1];
    if (!ledger) fail('--ledger needs a path');
    i += 1;
  } else if (arg === '--older-than') {
    const minutes = Number.parseFloat(args[i + 1]);
    if (!Number.isFinite(minutes) || minutes < 0) fail('--older-than needs minutes (0 disables)');
    retentionMs = Math.round(minutes * 60_000);
    i += 1;
  } else {
    fail(`unknown argument: ${arg}`);
  }
}

if (dirs.length === 0) fail('no --dir given (use --help for usage)');
if (retentionMs <= 0) fail('retention is 0/off — nothing to do');

const ledgerPath = path.resolve(process.cwd(), ledger);
if (!existsSync(ledgerPath)) fail(`ledger not found: ${ledgerPath}`);

const totals = { deleted: 0, freedBytes: 0, keptUnsent: 0, keptNoNumber: 0, keptYoung: 0 };

console.log(
  `[prune-screenshots] ledger=${ledgerPath} window=${Math.round(retentionMs / 60000)} min` +
    `${dryRun ? ' (dry run)' : ''}`
);

for (const dir of dirs) {
  const fullDir = path.resolve(process.cwd(), dir);
  if (!existsSync(fullDir) || !statSync(fullDir).isDirectory()) {
    console.log(`[prune-screenshots] skip (not a directory): ${fullDir}`);
    continue;
  }

  const result = pruneSentScreenshots({
    screenshotsDir: fullDir,
    seenNumbersFile: ledgerPath,
    retentionMs,
    dryRun
  });

  totals.deleted += result.deleted.length;
  totals.freedBytes += result.freedBytes;
  totals.keptUnsent += result.keptUnsent;
  totals.keptNoNumber += result.keptNoNumber;
  totals.keptYoung += result.keptYoung;

  const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(1);
  console.log(
    `[prune-screenshots] ${fullDir}: ${dryRun ? 'would delete' : 'deleted'} ${result.deleted.length}` +
      ` file(s), ${freedMb} MB · kept unsent=${result.keptUnsent} unnumbered=${result.keptNoNumber}` +
      ` young=${result.keptYoung} changed=${result.keptChanged} unreadable=${result.keptUnreadable}`
  );
}

const freedMb = (totals.freedBytes / (1024 * 1024)).toFixed(1);
console.log(
  `[prune-screenshots] total: ${dryRun ? 'would delete' : 'deleted'} ${totals.deleted} file(s), ` +
    `${freedMb} MB · kept unsent=${totals.keptUnsent} unnumbered=${totals.keptNoNumber} young=${totals.keptYoung}`
);
