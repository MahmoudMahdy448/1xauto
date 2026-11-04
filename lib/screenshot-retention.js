// Screenshot retention: free disk space by deleting screenshots that have
// already been delivered, without ever deleting one that has not.
//
// A screenshot is deleted only when ALL of these are true:
//   1. its filename carries a phone number (an unparsable file is kept);
//   2. that number is in the ledger, i.e. it was claimed by a sender before a
//      send and therefore is unique across every shard;
//   3. the file is older than the retention window, so the claim has had ample
//      time to become a delivered send.
//
// Why (2)+(3) is safe even though the ledger is written before the send: if the
// process died between claim and send, the screenshot stays on disk forever
// otherwise, but it can never be delivered either — the sender ignores files
// older than its own start time. Waiting out the window means we only delete
// files that are either delivered or permanently undeliverable. Screenshots
// whose send failed are released from the ledger, so they are kept for retry.

import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import path from 'path';
import { readSeenNumbers } from './dedup.js';
import { extractNumberFromScreenshotName } from './telegram.js';

export const DEFAULT_SCREENSHOT_RETENTION_MS = 15 * 60 * 1000;

const IMAGE_RE = /\.(png|jpe?g)$/i;

// SCREENSHOT_RETENTION=off|false|0 disables deletion.
// SCREENSHOT_RETENTION_MS=<ms> overrides the window (0 also disables).
export function screenshotRetentionMs(env = process.env) {
  const switchValue = String(env.SCREENSHOT_RETENTION ?? '').trim().toLowerCase();
  if (switchValue === 'off' || switchValue === 'false' || switchValue === 'no' || switchValue === '0') {
    return 0;
  }

  const configured = Number.parseInt(env.SCREENSHOT_RETENTION_MS ?? '', 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }

  return DEFAULT_SCREENSHOT_RETENTION_MS;
}

export function pruneSentScreenshots({
  screenshotsDir,
  seenNumbersFile,
  retentionMs = DEFAULT_SCREENSHOT_RETENTION_MS,
  now = Date.now(),
  // Report candidates in `deleted` without unlinking them (CLI --dry-run).
  dryRun = false
} = {}) {
  const result = {
    scanned: 0,
    deleted: [],
    keptYoung: 0,
    keptUnsent: 0,
    keptNoNumber: 0,
    keptChanged: 0,
    keptUnreadable: 0,
    freedBytes: 0
  };

  if (!retentionMs || retentionMs <= 0 || !screenshotsDir || !existsSync(screenshotsDir)) {
    return result;
  }

  let names;
  try {
    names = readdirSync(screenshotsDir);
  } catch {
    return result;
  }

  // Cheap pass first: only files old enough to delete and with a number are
  // candidates. The ledger (which can be hundreds of KB) is read only when
  // there is actually something to check.
  const candidates = [];
  for (const name of names) {
    if (!IMAGE_RE.test(name)) continue;
    result.scanned += 1;

    const fullPath = path.join(screenshotsDir, name);
    let info;
    try {
      info = statSync(fullPath);
    } catch {
      result.keptUnreadable += 1;
      continue;
    }
    if (!info.isFile()) continue;

    if (now - info.mtimeMs < retentionMs) {
      result.keptYoung += 1;
      continue;
    }

    const number = extractNumberFromScreenshotName(name);
    if (!number) {
      result.keptNoNumber += 1;
      continue;
    }

    candidates.push({ name, fullPath, number, mtimeMs: info.mtimeMs, size: info.size });
  }

  if (candidates.length === 0) return result;

  const seen = readSeenNumbers(seenNumbersFile);
  if (seen.size === 0) {
    result.keptUnsent += candidates.length;
    return result;
  }

  for (const candidate of candidates) {
    if (!seen.has(candidate.number)) {
      result.keptUnsent += 1;
      continue;
    }

    // Re-check right before unlinking: the capture may have rewritten the same
    // filename since the first stat, and a fresh screenshot must survive.
    let current;
    try {
      current = statSync(candidate.fullPath);
    } catch {
      continue;
    }
    if (current.mtimeMs !== candidate.mtimeMs || current.size !== candidate.size) {
      result.keptChanged += 1;
      continue;
    }
    if (now - current.mtimeMs < retentionMs) {
      result.keptYoung += 1;
      continue;
    }

    if (dryRun) {
      result.deleted.push(candidate.name);
      result.freedBytes += candidate.size;
      continue;
    }

    try {
      rmSync(candidate.fullPath, { force: true });
      result.deleted.push(candidate.name);
      result.freedBytes += candidate.size;
    } catch {
      result.keptUnreadable += 1;
    }
  }

  return result;
}
