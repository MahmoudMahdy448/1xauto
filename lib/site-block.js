// site-block.js
// Circuit breaker for the IP-level wall 1xbet serves when too many logins come
// from one address: a modal that says
//
//   Error
//   Suspicious activity detected. Try again later.
//
// This is not an account problem. Every login from the IP fails, so walking to
// the next account only burns accounts. The shard that sees it writes one shared
// file; every loop reads it and parks until the deadline. The first account that
// logs in successfully afterwards clears it.
//
// Nothing here touches Playwright or Telegram: it is the pure state layer.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs';
import path from 'path';

export const SITE_BLOCK_PATTERNS = [
  /suspicious activity/i,
  /try again later/i
];

export function matchesSiteBlock(text) {
  if (!text) return false;
  return SITE_BLOCK_PATTERNS.some((re) => re.test(String(text)));
}

// Thrown when the login page shows the block modal. lib/retry.js matches the
// prefix as non-retryable, so the account is not retried and the pass stops
// instead of spending the rest of the range on the same wall.
export class SiteBlockedError extends Error {
  constructor(detail) {
    super(
      detail
        ? `SITE_BLOCKED: ${detail}`
        : 'SITE_BLOCKED: 1xbet is blocking this IP — "Suspicious activity detected. Try again later."'
    );
    this.name = 'SiteBlockedError';
    this.code = 'SITE_BLOCKED';
  }
}

export function blockFilePath(env = process.env) {
  return path.resolve(process.cwd(), env.SITE_BLOCK_FILE || 'site-block.json');
}

// The wait grows while the block persists: 15 -> 30 -> 60 -> 120 min, then it
// stays at the last value. A pause that long is not a lost batch; it is what
// lets the block age out instead of re-triggering it.
export function parseBlockLadder(raw) {
  const parts = String(raw ?? '15,30,60,120')
    .split(',')
    .map((value) => parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return parts.length ? parts : [15, 30, 60, 120];
}

function ladderMs(blockCount, env) {
  const ladder = parseBlockLadder(env.SITE_BLOCK_LADDER_MINUTES);
  const index = Math.min(Math.max(blockCount, 1) - 1, ladder.length - 1);
  return ladder[index] * 60_000;
}

function lockPath(file) {
  return `${file}.lock`;
}

function withLock(file, fn) {
  const lock = lockPath(file);
  let fd = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const until = Date.now() + 25;
      while (Date.now() < until) {
        // deliberately synchronous: callers are single-threaded loops
      }
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      try {
        rmSync(lock, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

export function emptyBlock() {
  return {
    version: 1,
    service: '1xbet',
    blocked: false,
    detectedAt: null,
    blockedUntil: null,
    reason: null,
    detectedBy: null,
    blockCount: 0,
    lastAlertedAt: null,
    screenshot: null,
    recoveredAt: null,
    recoveredBy: null,
    updatedAt: null
  };
}

export function readSiteBlock(env = process.env) {
  const file = blockFilePath(env);
  const base = emptyBlock();
  if (!existsSync(file)) return base;
  try {
    // Strip a UTF-8 BOM: PowerShell's Set-Content writes one, and JSON.parse
    // rejects it. Without this, a hand-edited breaker file fails open and the
    // farm starts a live pass straight into the wall.
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return { ...base, ...parsed };
  } catch (error) {
    console.error(
      `[block] could not read ${path.basename(file)} (${error.message}) — treating the IP as unblocked`
    );
    return base;
  }
}

function writeBlock(block, env) {
  const file = blockFilePath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(block, null, 2));
  renameSync(tmp, file);
  return block;
}

export function blockDue(block, now = new Date()) {
  if (!block?.blocked || !block.blockedUntil) return false;
  return now.getTime() >= Date.parse(block.blockedUntil);
}

// Records a block. Duplicate detections inside the same wait window are merged
// (the sibling shard hits the same wall seconds later); a detection after the
// window expired counts as a new attempt and grows the wait.
export function markSiteBlocked({ reason, account, shard, screenshot } = {}, env = process.env) {
  const file = blockFilePath(env);
  return withLock(file, () => {
    const now = new Date();
    const current = readSiteBlock(env);

    if (current.blocked && Date.parse(current.blockedUntil) > now.getTime()) {
      return { changed: false, shouldAlert: false, block: current };
    }

    const blockCount = (current.blockCount || 0) + 1;
    const block = writeBlock(
      {
        ...current,
        blocked: true,
        detectedAt: now.toISOString(),
        blockedUntil: new Date(now.getTime() + ladderMs(blockCount, env)).toISOString(),
        reason: reason ? String(reason).slice(0, 300) : 'Suspicious activity detected. Try again later.',
        detectedBy: account || shard ? { account: account || null, shard: shard || null } : null,
        blockCount,
        lastAlertedAt: now.toISOString(),
        screenshot: screenshot || current.screenshot || null,
        recoveredAt: null,
        recoveredBy: null,
        updatedAt: now.toISOString()
      },
      env
    );

    return { changed: true, shouldAlert: true, block };
  });
}

// Called on the first successful login after a block: the IP is accepted again.
export function markSiteUnblocked({ account, shard } = {}, env = process.env) {
  const file = blockFilePath(env);
  return withLock(file, () => {
    const now = new Date();
    const current = readSiteBlock(env);
    if (!current.blocked) return { changed: false, block: current };

    const block = writeBlock(
      {
        ...current,
        blocked: false,
        blockedUntil: null,
        blockCount: 0,
        screenshot: null,
        recoveredAt: now.toISOString(),
        recoveredBy: account || shard ? { account: account || null, shard: shard || null } : null,
        updatedAt: now.toISOString()
      },
      env
    );
    return { changed: true, block };
  });
}

function cairoTime(iso) {
  const date = iso ? new Date(iso) : new Date();
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: process.env.MONITOR_TZ || 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

function minutesUntil(iso, now = new Date()) {
  const ms = Date.parse(iso) - now.getTime();
  return Math.max(0, Math.round(ms / 60_000));
}

export function buildSiteBlockText(block) {
  const who = block.detectedBy
    ? `${block.detectedBy.shard || 'unknown'} (${block.detectedBy.account || 'unknown'})`
    : 'unknown';
  return [
    '⛔ 1xbet is blocking this IP — the whole farm is parked',
    `"${block.reason || 'Suspicious activity detected. Try again later.'}"`,
    `Seen ${cairoTime(block.detectedAt)} Cairo by ${who}`,
    `No accounts will be opened for ${minutesUntil(block.blockedUntil)} min (retry ${cairoTime(block.blockedUntil)}).`,
    block.blockCount > 1
      ? `This is block #${block.blockCount} — the IP needs a proxy, not more retries.`
      : 'If this happens again, the IP needs a proxy.'
  ].join('\n');
}

export function buildSiteUnblockedText(block) {
  const who = block.recoveredBy
    ? `${block.recoveredBy.shard || 'unknown'} (${block.recoveredBy.account || 'unknown'})`
    : 'unknown';
  return [
    '✅ 1xbet is accepting logins again',
    `First successful login ${cairoTime(block.recoveredAt)} Cairo by ${who}.`,
    'Farm resumed.'
  ].join('\n');
}
