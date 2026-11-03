// deposit-gate.js
// State machine for a disabled 1xbet deposit method (currently Vodafone).
//
// The site flips one attribute on the payment cell and answers the click with an
// "Information message" modal instead of the payment window. When that happens
// every remaining account in the pass produces a screenshot with no number, so
// the shards must stop and poll cheaply until the method is back.
//
// The state lives in one JSON file shared by both shards. Writes go through a
// temp file + rename, and a short lock, so the two processes cannot interleave
// a read-modify-write and lose the transition.
//
// Nothing here touches Playwright or Telegram: it is the pure state layer.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

export const RESTRICTION_PATTERNS = [
  /this method is not available due to technical issues/i,
  /not available due to technical issues/i,
  /method (?:is )?(?:currently )?(?:unavailable|disabled)/i
];

export function matchesRestriction(text) {
  if (!text) return false;
  return RESTRICTION_PATTERNS.some((re) => re.test(String(text)));
}

// Thrown when an account lands on the restriction modal. The prefix is matched
// by lib/retry.js as non-retryable, so the pass stops instead of spending three
// more logins on the same answer.
export class PaymentDisabledError extends Error {
  constructor(message = 'PAYMENT_METHOD_DISABLED: Vodafone deposit is not available due to technical issues') {
    super(message);
    this.name = 'PaymentDisabledError';
    this.code = 'PAYMENT_METHOD_DISABLED';
  }
}

export function parseLadder(raw) {
  const parts = String(raw ?? '5,15,15,15')
    .split(',')
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => Number.isInteger(v) && v >= 0);
  return parts.length ? parts : [5, 15, 15, 15];
}

export function gateFilePath(env = process.env) {
  return path.resolve(process.cwd(), env.GATE_FILE || 'deposit-gate.json');
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
      // Another writer is mid-transition; wait a few milliseconds and retry.
      const until = Date.now() + 25;
      while (Date.now() < until) {
        // deliberately synchronous: callers are single-threaded cron-style loops
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

export function emptyGate() {
  return {
    version: 1,
    service: '1xbet',
    method: 'vodafone',
    disabled: false,
    since: null,
    restoredAt: null,
    reason: null,
    detectedBy: null,
    screenshots: [],
    lastCheckedAt: null,
    nextCheckAt: null,
    ladderIndex: 0,
    probeCount: 0,
    probeFailures: 0,
    reminderAt: null,
    alertedDisabledAt: null,
    alertedEnabledAt: null,
    notifyPending: null,
    updatedAt: null
  };
}

export function readGate(env = process.env) {
  const file = gateFilePath(env);
  const base = emptyGate();
  if (!existsSync(file)) return base;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { ...base, ...parsed };
  } catch {
    // A half-written or hand-edited file must not stop the farm.
    return base;
  }
}

function writeGate(state, env = process.env) {
  const file = gateFilePath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const next = { ...state, updatedAt: new Date().toISOString() };
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, file);
  return next;
}

export function isGateDisabled(env = process.env) {
  return readGate(env).disabled === true;
}

function nextCheckAt(now, ladderIndex, env = process.env) {
  const ladder = parseLadder(env.GATE_CHECK_LADDER_MINUTES);
  const minutes = ladder[Math.min(ladderIndex, ladder.length - 1)];
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function flapSuppressMs(env = process.env) {
  const minutes = parseInt(env.GATE_FLAP_SUPPRESS_MINUTES ?? '5', 10);
  return (Number.isInteger(minutes) ? minutes : 5) * 60_000;
}

function reminderMs(env = process.env) {
  const minutes = parseInt(env.GATE_REMINDER_MINUTES ?? '60', 10);
  return (Number.isInteger(minutes) ? minutes : 60) * 60_000;
}

// Called the moment an account sees the restriction modal. Returns whether the
// caller should send the alert: a second shard that races us gets `changed:
// false`, and a re-detection inside the flap window gets `notify: false`.
export function markDisabled({ reason, account, shard, screenshots = [] } = {}, env = process.env) {
  const file = gateFilePath(env);
  return withLock(file, () => {
    const now = new Date();
    const current = readGate(env);
    if (current.disabled) {
      return { changed: false, notify: false, gate: current };
    }

    const suppressed =
      current.alertedDisabledAt &&
      now.getTime() - Date.parse(current.alertedDisabledAt) < flapSuppressMs(env);

    const gate = writeGate(
      {
        ...current,
        disabled: true,
        since: now.toISOString(),
        restoredAt: null,
        reason: reason || 'This method is not available due to technical issues',
        detectedBy: account || shard ? { account: account || null, shard: shard || null } : null,
        screenshots,
        ladderIndex: 0,
        nextCheckAt: nextCheckAt(now, 0, env),
        reminderAt: new Date(now.getTime() + reminderMs(env)).toISOString(),
        probeFailures: 0,
        notifyPending: null,
        alertedDisabledAt: suppressed ? current.alertedDisabledAt : now.toISOString()
      },
      env
    );

    return { changed: true, notify: !suppressed, gate };
  });
}

// Called after a probe that found the method still disabled.
export function markStillDisabled({ screenshots } = {}, env = process.env) {
  const file = gateFilePath(env);
  return withLock(file, () => {
    const now = new Date();
    const current = readGate(env);
    if (!current.disabled) return { changed: false, gate: current };

    const ladderIndex = current.ladderIndex + 1;
    const gate = writeGate(
      {
        ...current,
        lastCheckedAt: now.toISOString(),
        ladderIndex,
        nextCheckAt: nextCheckAt(now, ladderIndex, env),
        probeCount: current.probeCount + 1,
        probeFailures: 0,
        screenshots: screenshots && screenshots.length ? screenshots : current.screenshots
      },
      env
    );
    return { changed: true, gate };
  });
}

// A probe that failed for a reason unrelated to the gate (login error, timeout).
// It must not clear the gate, or a broken probe account would resume the farm
// into a disabled wallet.
export function markProbeFailed({ error } = {}, env = process.env) {
  const file = gateFilePath(env);
  return withLock(file, () => {
    const now = new Date();
    const current = readGate(env);
    if (!current.disabled) return { changed: false, gate: current };

    const probeFailures = (current.probeFailures || 0) + 1;
    const backoffMinutes = probeFailures >= 3 ? 10 : 5;
    const gate = writeGate(
      {
        ...current,
        lastCheckedAt: now.toISOString(),
        nextCheckAt: new Date(now.getTime() + backoffMinutes * 60_000).toISOString(),
        probeCount: current.probeCount + 1,
        probeFailures,
        lastProbeError: error ? String(error).slice(0, 300) : null
      },
      env
    );
    return {
      changed: true,
      gate,
      shouldAlertProbeBroken: probeFailures === 3
    };
  });
}

// Called when an account produced a real number. Self-healing: the probe that
// proves the wallet is back is just a normal successful account.
export function markEnabled({ account, shard, screenshot } = {}, env = process.env) {
  const file = gateFilePath(env);
  return withLock(file, () => {
    const now = new Date();
    const current = readGate(env);
    if (!current.disabled) return { changed: false, notify: false, gate: current };

    const gate = writeGate(
      {
        ...current,
        disabled: false,
        restoredAt: now.toISOString(),
        nextCheckAt: null,
        reminderAt: null,
        probeFailures: 0,
        restoredBy: account || shard ? { account: account || null, shard: shard || null } : null,
        screenshots: screenshot ? [screenshot] : current.screenshots,
        alertedEnabledAt: now.toISOString()
      },
      env
    );
    return { changed: true, notify: true, gate };
  });
}

export function reminderDue(gate, now = new Date()) {
  if (!gate?.disabled || !gate.reminderAt) return false;
  return now.getTime() >= Date.parse(gate.reminderAt);
}

export function markReminderSent(env = process.env) {
  const file = gateFilePath(env);
  return withLock(file, () => {
    const now = new Date();
    const current = readGate(env);
    if (!current.disabled) return current;
    return writeGate(
      {
        ...current,
        reminderAt: new Date(now.getTime() + reminderMs(env)).toISOString(),
        lastReminderAt: now.toISOString()
      },
      env
    );
  });
}

// ---------------------------------------------------------------------------
// Display helpers. Cairo time, because every alert is read next to the ISP
// quota page which is also local.
// ---------------------------------------------------------------------------

export function cairoTime(iso) {
  if (!iso) return 'n/a';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(iso));
  } catch {
    return 'n/a';
  }
}

function minutesBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 60_000));
}

export function channelCaption(kind, gate) {
  if (kind === 'enabled') return `✅ vodafone back ${cairoTime(gate.restoredAt)}`;
  if (kind === 'reminder') return `⏳ vodafone still down ${cairoTime(new Date().toISOString())}`;
  return `⛔ vodafone disabled ${cairoTime(gate.since)}`;
}

export function buildAlertText(kind, gate) {
  const who = gate.detectedBy
    ? `${gate.detectedBy.shard || 'unknown'}${gate.detectedBy.account ? ` (${gate.detectedBy.account})` : ''}`
    : 'unknown';

  if (kind === 'enabled') {
    return [
      '✅ Vodafone deposit is back — 1xbet',
      `Down ${cairoTime(gate.since)} → ${cairoTime(gate.restoredAt)} Cairo (${minutesBetween(gate.since, gate.restoredAt)} min)`,
      `${gate.probeCount || 0} probe(s) while paused. Full pass resuming now.`
    ].join('\n');
  }

  if (kind === 'reminder') {
    return [
      '⏳ Vodafone still disabled — 1xbet',
      `Down since ${cairoTime(gate.since)} Cairo (${minutesBetween(gate.since, new Date().toISOString())} min)`,
      `Last checked ${cairoTime(gate.lastCheckedAt)} · next ${cairoTime(gate.nextCheckAt)}`
    ].join('\n');
  }

  return [
    '⛔ Vodafone deposit disabled — 1xbet',
    `Detected ${cairoTime(gate.since)} Cairo by ${who}`,
    `"${gate.reason || 'This method is not available due to technical issues'}"`,
    `Flow paused. Silent probe at ${cairoTime(gate.nextCheckAt)}, then every 15 min.`,
    `You will get a reminder if it is still down after 60 min.`
  ].join('\n');
}

// One short admin-only line per silent probe. It is not an alert: it exists so
// the operator can see the checks are happening without waiting for the
// 60-minute reminder.
export function buildStillDownText(gate) {
  return [
    '⏳ Vodafone still down — 1xbet',
    `Probe ${cairoTime(gate.lastCheckedAt)} · ${minutesBetween(gate.since, gate.lastCheckedAt || new Date().toISOString())} min down · check #${gate.probeCount || 0}`,
    `Next probe ${cairoTime(gate.nextCheckAt)} · reminder ${cairoTime(gate.reminderAt)}`
  ].join('\n');
}

export function buildProbeBrokenText(gate) {
  return [
    '⚠️ Gate probe is failing — 1xbet',
    `${gate.probeFailures} checks in a row could not complete (login error, not the wallet message).`,
    `Last error: ${gate.lastProbeError || 'unknown'}`,
    'The wallet may be back but the probe cannot tell. Accounts stay paused.',
    'Check the probe accounts or run: node scripts/gate-clear.mjs'
  ].join('\n');
}
