// monitor-agent.mjs — tails the event logs, keeps monitor-state.json, and
// sends alerts to the admin chat.
//
// Rules it obeys (plan v2.1):
//   - silent by default: it speaks only when something is wrong, plus one
//     09:00 all-clear line as proof of life
//   - never sends to the Telegram channel, only to TELEGRAM_CHAT_ID
//   - one writer of monitor-state.json, one writer of alert-control.json
//   - startup never replays history: old event files are opened at EOF
//   - monitoring failures never throw into the scraping processes

import { existsSync, readFileSync, writeFileSync, unlinkSync, statfsSync, statSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  readFrom,
  listEventFiles,
  parseEventLines
} from '../lib/events.js';
import { readState, writeState } from '../lib/state.js';
import { sendTelegramMessage, sendTelegramPhotoWithRetry } from '../lib/telegram.js';
import {
  SCRAPE_SERVICES,
  normalizeServiceName,
  servicePaths
} from '../config/services.js';
import {
  emptyState,
  DEFAULT_CONFIG,
  localParts,
  isQuietHour,
  normalizeErrorKey,
  recordError,
  recordFailure,
  touchIncident,
  expireIncidents,
  allowAlert,
  noteAlert,
  canSendPhoto,
  notePhoto,
  noteSuppressed,
  markResolved,
  dailyPingDue,
  markDailyPing,
  rollDailyCounters,
  pruneState,
  isInsideDir
} from '../lib/alert-rules.js';

dotenv.config();

const ROOT = process.cwd();
const STATE_FILE = path.resolve(ROOT, process.env.MONITOR_STATE_FILE || 'monitor-state.json');
const CONTROL_FILE = path.resolve(ROOT, process.env.ALERT_CONTROL_FILE || 'alert-control.json');
const LOCK_FILE = path.resolve(ROOT, process.env.MONITOR_AGENT_PID || 'monitor-agent.pid');
const LEDGER_FILE = path.resolve(ROOT, process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json');
const GATE_FILE = path.resolve(ROOT, process.env.GATE_FILE || 'deposit-gate.json');
const TICK_MS = parseInt(process.env.MONITOR_TICK_MS, 10) || 15_000;
const STARTUP_GRACE_MS = (() => {
  const minutes = parseInt(process.env.MONITOR_STARTUP_GRACE_MINUTES, 10);
  return (Number.isFinite(minutes) ? minutes : 5) * 60_000;
})();
const STALE_FILE_MS = 10 * 60_000;
const TAIL_BYTES = 64 * 1024;

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!botToken || !chatId) {
  console.error('[monitor-agent] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing — alerts will only be written to state.');
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      if (lock?.pid && pidAlive(lock.pid)) {
        console.error(`[monitor-agent] already running as PID ${lock.pid} — exiting.`);
        process.exit(3);
      }
    }
  } catch {
    // unreadable lock is a stale lock
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
}

function releaseLock() {
  try {
    const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (lock?.pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEFAULT_CONFIG.timeZone,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEFAULT_CONFIG.timeZone,
  day: '2-digit',
  month: 'short'
});
const stampFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEFAULT_CONFIG.timeZone,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

function t(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : timeFmt.format(d);
}

function stamp(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : stampFmt.format(d);
}

function day(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : dateFmt.format(d);
}

function relAge(iso, nowMs = Date.now()) {
  if (!iso) return 'never';
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return minutes ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
}

function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function loadState() {
  const loaded = readState(STATE_FILE);
  const base = emptyState();
  const merged = { ...base, ...(loaded || {}) };
  merged.daily = { ...base.daily, ...(loaded?.daily || {}) };
  merged.alertHour = { ...base.alertHour, ...(loaded?.alertHour || {}) };
  merged.photoHour = { ...base.photoHour, ...(loaded?.photoHour || {}) };
  merged.offsets = { ...(loaded?.offsets || {}) };
  merged.services = { ...(loaded?.services || {}) };
  merged.errors = Array.isArray(loaded?.errors) ? loaded.errors : [];
  merged.incidents = Array.isArray(loaded?.incidents) ? loaded.incidents : [];
  merged.failures = Array.isArray(loaded?.failures) ? loaded.failures : [];
  merged.suppressed = Array.isArray(loaded?.suppressed) ? loaded.suppressed : [];
  merged.pendingMessages = Array.isArray(loaded?.pendingMessages) ? loaded.pendingMessages : [];
  merged.lastAlertByRule = { ...(loaded?.lastAlertByRule || {}) };
  return merged;
}

const state = loadState();
state.agentStartedAt = new Date().toISOString();

// Close incidents that expired while the agent was down, silently. Otherwise a
// restart would announce resolutions for problems from yesterday.
for (const incident of state.incidents) {
  if (incident.closedAt) continue;
  if (Date.parse(incident.expiresAt) < Date.now()) {
    incident.closedAt = new Date().toISOString();
    incident.notifiedResolved = true;
  }
}

function svcState(svc) {
  if (!state.services[svc]) {
    state.services[svc] = {
      state: 'unknown',
      lastEventAt: null,
      lastKind: null,
      lastRole: null,
      startedAt: null,
      batch: null,
      lastBatch: null,
      accounts: { ok: 0, failed: 0 },
      numbers: { extracted: 0, sent: 0, skipped: 0 },
      sender: 'unknown',
      lastError: null,
      lastErrorShot: null,
      lastStep: null,
      sendFailures: {},
      sync: null
    };
  }
  const s = state.services[svc];
  // Shapes saved by an older version may miss fields.
  s.accounts = s.accounts || { ok: 0, failed: 0 };
  s.numbers = s.numbers || { extracted: 0, sent: 0, skipped: 0 };
  s.sendFailures = s.sendFailures || {};
  return s;
}

function readControl() {
  try {
    if (!existsSync(CONTROL_FILE)) return {};
    return JSON.parse(readFileSync(CONTROL_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

const outbox = [];

function pushOutbox(message) {
  outbox.push(message);
}

async function flushOutbox() {
  if (!botToken || !chatId) {
    outbox.length = 0;
    return;
  }
  while (outbox.length > 0) {
    const message = outbox.shift();
    let text = message.text;
    if (message.late && message.label) {
      text = `(due ${message.label})\n${text}`;
    }
    try {
      if (message.photoPath && existsSync(message.photoPath)) {
        await sendTelegramPhotoWithRetry({
          botToken,
          chatId,
          photoPath: message.photoPath,
          caption: text.slice(0, 1024)
        });
      } else {
        await sendTelegramMessage({ botToken, chatId, text: text.slice(0, 4096) });
      }
      await sleep(500);
    } catch (error) {
      console.error(`[monitor-agent] send failed: ${error.message}`);
      state.pendingMessages.push({
        text: message.text,
        photoPath: message.photoPath || null,
        dueAt: message.dueAt || new Date().toISOString(),
        label: message.label || null,
        late: true,
        failedAt: new Date().toISOString()
      });
      await sleep(1000);
    }
  }
}

// ---------------------------------------------------------------------------
// Alert raising
// ---------------------------------------------------------------------------

function raise({
  rule,
  svc,
  severity = 'warning',
  summary = '',
  text,
  photoPath = null,
  ttlMs,
  countEvent = true,
  // The newest event this alert is based on. Recovery closes the incident only
  // when a *later* event arrives, so a replayed event from the startup tail can
  // never resolve a problem that is still active.
  eventTs = null
}) {
  const now = new Date();
  const { incident } = touchIncident(state, {
    rule,
    svc,
    ts: now.toISOString(),
    ttlMs: ttlMs || 20 * 60_000,
    severity,
    summary,
    countEvent
  });
  if (eventTs) incident.lastEventAt = eventTs;

  // One message per incident. Repeats refresh the incident, they do not ping.
  if (incident.alerted) return;

  const gate = allowAlert(state, {
    rule,
    svc,
    severity,
    now,
    mutedUntil: mutedUntil(now)
  });

  if (!gate.allowed) {
    if (gate.reason === 'quiet-hours' || gate.reason === 'muted') {
      if (!incident.suppressed) {
        noteSuppressed(state, { rule, svc, at: now.toISOString() });
        incident.suppressed = true;
      }
    }
    return;
  }

  incident.alerted = true;
  noteAlert(state, { rule, svc, now });

  let finalPhoto = photoPath;
  let finalText = text;
  if (finalPhoto && !canSendPhoto(state, now)) {
    finalPhoto = null;
    finalText = `${finalText}\n📷 screenshot suppressed (10/h cap) — /errors`;
  }
  if (finalPhoto) notePhoto(state, now);

  pushOutbox({ text: finalText, photoPath: finalPhoto, dueAt: now.toISOString() });
}

function mutedUntil(now = new Date()) {
  const control = readControl();
  if (!control.mutedUntil) return null;
  return Date.parse(control.mutedUntil) > now.getTime() ? control.mutedUntil : null;
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function stormText(svc, count, key, ts) {
  return [
    `🟡 STORM · ${svc} · ${t(ts)} Cairo`,
    `${count} failures in 15 min (threshold ${DEFAULT_CONFIG.stormCount})`,
    `top error: ${key}`,
    'no per-account messages were sent'
  ].join('\n');
}

function siteWideText(siteWide, ts) {
  return [
    `🔴 SITE-WIDE · ${t(ts)} Cairo`,
    `same error on ${siteWide.svcs.join(', ')} — ${siteWide.count} failures in 10 min`,
    `error: ${siteWide.key}`,
    'action: check the site or proxy first; every shard is affected'
  ].join('\n');
}

function newErrorText(svc, step, message, ts) {
  return [
    `🟡 NEW ERROR · ${svc} · ${t(ts)} Cairo`,
    `step: ${step || 'account'}`,
    `error: ${String(message).slice(0, 300)}`,
    'first time this signature was seen — /errors for the list'
  ].join('\n');
}

function resolutionText(incident) {
  const opened = Date.parse(incident.openedAt);
  const closed = Date.parse(incident.closedAt);
  const lasted = Number.isFinite(opened) && Number.isFinite(closed) ? duration(closed - opened) : 'unknown';
  return [
    `🟢 RESOLVED · ${incident.svc} ${incident.rule} · lasted ${lasted}`,
    `opened ${t(incident.openedAt)} → closed ${t(incident.closedAt)} (${day(incident.closedAt)})`,
    incident.count > 1 ? `${incident.count} events while open` : '1 event'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

function checkShotPath(svc, shot, ts) {
  const paths = servicePaths(svc, ROOT);
  if (!paths?.screenshots) return;
  if (isInsideDir(shot, paths.screenshots)) return;
  raise({
    rule: 'shot.path',
    svc,
    severity: 'critical',
    summary: `shot outside ${paths.screenshots}`,
    ttlMs: 60 * 60_000,
    text: [
      `🔴 SHOT PATH · ${svc} · ${t(ts)} Cairo`,
      `screenshot saved outside ${paths.screenshots}`,
      String(shot).slice(0, 200),
      'realtime-send cannot see it, so this number will not be delivered'
    ].join('\n')
  });
}

function handleEvent(event) {
  const svc = normalizeServiceName(event.svc);
  const s = svcState(svc);
  const ts = event.ts || new Date().toISOString();
  const data = event.data || {};

  if (!s.lastEventAt || ts > s.lastEventAt) {
    s.lastEventAt = ts;
    s.lastKind = event.kind;
    s.lastRole = event.role || null;
  }

  switch (event.kind) {
    case 'service.started': {
      s.state = 'running';
      s.startedAt = ts;
      break;
    }
    case 'service.stopped': {
      s.state = 'stopped';
      break;
    }
    case 'batch.start': {
      s.state = 'running';
      s.batch = {
        id: event.batch || data.batch || ts,
        startedAt: ts,
        endedAt: null,
        ok: null,
        sender: 'unknown',
        senderStartedAt: null,
        accounts: { ok: 0, failed: 0 },
        numbers: { extracted: 0, sent: 0, skipped: 0 }
      };
      break;
    }
    case 'batch.end': {
      if (s.batch) {
        s.batch.endedAt = ts;
        s.batch.ok = data.ok ?? null;
        s.batch.unique = data.unique ?? null;
        s.batch.durationMs = data.durationMs ?? null;
        s.lastBatch = { ...s.batch };
      }
      // A pass that stopped because the wallet went away is parked, not
      // cooling down; the next status read must not look like a dead loop.
      const gateState = readJson(GATE_FILE);
      s.state = gateState?.disabled ? 'gated' : 'cooldown';
      if (state.daily.date) state.daily.batches += 1;
      break;
    }
    case 'account.done': {
      s.accounts.ok += 1;
      if (s.batch) s.batch.accounts.ok += 1;
      const numbers = Number(data.numbers);
      if (Number.isFinite(numbers)) {
        s.numbers.extracted += numbers;
        if (s.batch) s.batch.numbers.extracted += numbers;
      }
      break;
    }
    case 'account.failed': {
      s.accounts.failed += 1;
      if (s.batch) s.batch.accounts.failed += 1;
      const message = data.error || 'account failed';
      const key = normalizeErrorKey(message);
      s.lastError = { message, key, at: ts, svc, step: data.step || s.lastStep || 'account' };
      const knownError = state.errors.find((entry) => entry.key === key);
      recordError(state, { message, svc, ts });

      const { storm, siteWide } = recordFailure(state, { svc, key, ts });
      if (siteWide) {
        raise({
          rule: `site-wide:${siteWide.key.slice(0, 50)}`,
          svc: 'all',
          severity: 'critical',
          summary: siteWide.key,
          ttlMs: 20 * 60_000,
          text: siteWideText(siteWide, ts)
        });
      } else if (storm) {
        raise({
          rule: 'storm',
          svc,
          severity: 'warning',
          summary: key,
          ttlMs: 20 * 60_000,
          text: stormText(svc, storm.count, key, ts)
        });
      } else if (!knownError) {
        // A brand-new error signature gets one screenshot. Repeats are counted
        // silently until the storm threshold is reached.
        const shot = s.lastErrorShot && existsSync(s.lastErrorShot) ? s.lastErrorShot : null;
        raise({
          rule: `new-error:${key.slice(0, 60)}`,
          svc,
          severity: 'warning',
          summary: key,
          ttlMs: 60 * 60_000,
          photoPath: shot,
          text: newErrorText(svc, data.step || s.lastStep || 'account', message, ts)
        });
      }
      break;
    }
    case 'sender.started': {
      s.sender = 'running';
      if (s.batch) {
        s.batch.sender = 'running';
        s.batch.senderStartedAt = ts;
      }
      break;
    }
    case 'sender.stopped': {
      s.sender = 'stopped';
      if (s.batch) s.batch.sender = 'stopped';
      break;
    }
    case 'send.ok': {
      s.numbers.sent += 1;
      if (s.batch) s.batch.numbers.sent += 1;
      if (state.daily.date) state.daily.numbersSent += 1;
      break;
    }
    case 'send.skip': {
      s.numbers.skipped += 1;
      if (s.batch) s.batch.numbers.skipped += 1;
      break;
    }
    case 'send.failed': {
      const number = data.number || 'unknown';
      s.sendFailures[number] = (s.sendFailures[number] || 0) + 1;
      const severity = s.sendFailures[number] >= 3 ? 'critical' : 'warning';
      raise({
        rule: severity === 'critical' ? `send-hard:${number}` : 'send',
        svc,
        severity,
        summary: String(data.error || 'send failed'),
        ttlMs: 30 * 60_000,
        eventTs: ts,
        text: [
          `${severity === 'critical' ? '🔴' : '🟡'} SEND FAILED · ${svc} · ${t(ts)} Cairo`,
          `number ${number} failed ${s.sendFailures[number]}×`,
          String(data.error || 'unknown error').slice(0, 300),
          'the number was released back to the ledger for retry'
        ].join('\n')
      });
      break;
    }
    case 'ledger.claim_failed': {
      raise({
        rule: 'ledger',
        svc,
        severity: 'critical',
        summary: String(data.error || 'claim failed'),
        ttlMs: 30 * 60_000,
        text: [
          `🔴 LEDGER · ${svc} · ${t(ts)} Cairo`,
          `claim failed: ${String(data.error || 'unknown').slice(0, 300)}`,
          'numbers may be sent twice until this is fixed'
        ].join('\n')
      });
      break;
    }
    case 'sync.start': {
      s.sync = { ...(s.sync || {}), lastStartAt: ts };
      s.state = 'running';
      break;
    }
    case 'sync.done': {
      s.sync = {
        ...(s.sync || {}),
        lastDoneAt: ts,
        messages: Number(data.messages) || 0,
        delivered: Number(data.delivered) || 0,
        ledger: Number(data.ledger) || 0,
        dropped: Number(data.dropped) || 0,
        pending: Number(data.pending) || 0,
        durationMs: Number(data.durationMs) || 0
      };
      s.state = 'idle';
      if (state.daily.date) {
        state.daily.syncs += 1;
        if (s.sync.dropped === 0) state.daily.syncClean += 1;
      }
      if (s.sync.ledger) state.ledger = { count: s.sync.ledger, checkedAt: ts };
      if (s.sync.dropped > 0 || s.sync.pending > 10) {
        raise({
          rule: 'sync-dropped',
          svc: 'sync',
          severity: 'critical',
          summary: `dropped ${s.sync.dropped}, pending ${s.sync.pending}`,
          ttlMs: 2 * 60 * 60_000,
          eventTs: ts,
          text: [
            `🔴 SYNC DROPPED · ${t(ts)} Cairo`,
            `${s.sync.dropped} number(s) confirmed never delivered`,
            `pending release: ${s.sync.pending} · ledger ${s.sync.ledger}`,
            'those numbers will be re-sent by the shards'
          ].join('\n')
        });
      }
      break;
    }
    case 'sync.failed': {
      s.state = 'failed';
      raise({
        rule: 'sync',
        svc: 'sync',
        severity: 'critical',
        summary: String(data.error || 'sync failed'),
        ttlMs: 2 * 60 * 60_000,
        eventTs: ts,
        text: [
          `🔴 SYNC FAILED · ${t(ts)} Cairo`,
          String(data.error || 'unknown error').slice(0, 300),
          'the ledger is not being reconciled against the channel'
        ].join('\n')
      });
      break;
    }
    case 'step.failed': {
      s.lastStep = event.step || 'step';
      s.lastError = {
        message: data.error || `${event.step} failed`,
        key: normalizeErrorKey(data.error || event.step),
        at: ts,
        svc,
        step: event.step || 'step'
      };
      if (data.shot) {
        // Error shots intentionally live outside the watched screenshots dir,
        // so they are never subject to the shot.path rule.
        s.lastErrorShot = data.shot;
      }
      break;
    }
    case 'shot.saved': {
      if (data.shot) checkShotPath(svc, data.shot, ts);
      break;
    }
    case 'cooldown.start': {
      s.state = 'cooldown';
      if (state.daily.date) state.daily.cooldowns = (state.daily.cooldowns || 0) + 1;
      break;
    }
    case 'cooldown.end': {
      s.state = 'running';
      break;
    }
    // The gate is its own state. The shard is alive; it just has nothing to
    // scrape until Vodafone comes back, so liveness must not call it silent.
    case 'gate.disabled': {
      s.state = 'gated';
      s.gate = { since: ts, reason: data.reason || null, shard: data.shard || null };
      break;
    }
    case 'gate.skip': {
      s.state = 'gated';
      break;
    }
    case 'gate.pass.stopped': {
      s.state = 'gated';
      break;
    }
    case 'gate.enabled': {
      s.state = 'running';
      s.gate = { ...(s.gate || {}), restoredAt: ts };
      break;
    }
    default:
      break;
  }

  resolveAfterEvent({ kind: event.kind, svc, ts, data });
}

// ---------------------------------------------------------------------------
// Event ingestion
// ---------------------------------------------------------------------------

let malformedThisPass = 0;

function decodeOffset(text, endOffset) {
  // A crash can leave a half-written last line. Do not consume it: rewind the
  // offset so the line is read again once it is complete.
  if (!text || text.endsWith('\n')) return { complete: text, offset: endOffset };
  const lastBreak = text.lastIndexOf('\n');
  const partial = lastBreak === -1 ? text : text.slice(lastBreak + 1);
  const complete = lastBreak === -1 ? '' : text.slice(0, lastBreak + 1);
  return { complete, offset: endOffset - Buffer.byteLength(partial, 'utf8') };
}

function ingest() {
  malformedThisPass = 0;
  const files = listEventFiles(ROOT);
  const seen = new Set();
  const collected = [];
  let seq = 0;

  for (const info of files) {
    seen.add(info.name);
    let offset = state.offsets[info.name];

    if (offset === undefined) {
      // First time we see this file: never replay history.
      if (Date.now() - info.mtimeMs > STALE_FILE_MS) {
        offset = info.size;
      } else {
        offset = Math.max(0, info.size - TAIL_BYTES);
      }
    }

    const { text, offset: endOffset } = readFrom(info.file, offset);
    const { complete, offset: safeOffset } = decodeOffset(text, endOffset);
    state.offsets[info.name] = safeOffset;

    if (!complete) continue;
    const { events, malformed } = parseEventLines(complete);
    malformedThisPass += malformed.length;
    for (const event of events) {
      collected.push({ event, seq: seq++ });
    }
  }

  // Files have different writers, so their read order is not event order.
  // Process globally by timestamp: batch.start must be seen before the scrape
  // events and the sender.started that belong to that batch.
  collected.sort((a, b) => {
    const ta = Date.parse(a.event.ts) || 0;
    const tb = Date.parse(b.event.ts) || 0;
    return ta === tb ? a.seq - b.seq : ta - tb;
  });

  for (const { event } of collected) {
    try {
      handleEvent(event);
    } catch (error) {
      console.error(`[monitor-agent] event handler failed: ${error.message}`);
    }
  }

  // Drop offsets for files that were rotated away.
  for (const key of Object.keys(state.offsets)) {
    if (!seen.has(key)) delete state.offsets[key];
  }

  if (malformedThisPass > DEFAULT_CONFIG.malformedLimit) {
    raise({
      rule: 'malformed',
      svc: 'monitor',
      severity: 'warning',
      summary: `${malformedThisPass} malformed lines`,
      ttlMs: 30 * 60_000,
      text: [
        `🟡 MALFORMED EVENTS · ${t(new Date().toISOString())} Cairo`,
        `${malformedThisPass} unparseable event lines in one pass`,
        'some steps are invisible to monitoring — /tail to inspect'
      ].join('\n')
    });
  }
}

// ---------------------------------------------------------------------------
// Liveness (event staleness only — never process inspection)
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function lastServiceEventMs(svc) {
  const s = state.services[svc];
  return s?.lastEventAt ? Date.parse(s.lastEventAt) : null;
}

// A scraper's stdout log advances once per account, even when that account
// yields no number. melbet only emits events when it finds one, so events alone
// made a healthy melbet look stalled for 15 minutes at a time. Events and the
// log move together for the shards, so taking the newer signal changes nothing
// there.
function lastActivityMs(svc) {
  const eventMs = lastServiceEventMs(svc);
  let logMs = null;
  try {
    logMs = statSync(path.resolve(ROOT, 'logs', `${svc}.log`)).mtimeMs;
  } catch {
    // no log for this service
  }
  if (eventMs === null) return logMs;
  if (logMs === null) return eventMs;
  return Math.max(eventMs, logMs);
}

function checkLiveness(now) {
  if (now.getTime() - Date.parse(state.agentStartedAt) < STARTUP_GRACE_MS) return;

  for (const svc of SCRAPE_SERVICES) {
    const s = state.services[svc] || {};
    const paths = servicePaths(svc, ROOT);
    const status = paths?.status ? readJson(paths.status) : null;
    const statusState = status?.state || 'unknown';

    // A freshly restarted shard gets 5 minutes before it is called silent.
    if (s.startedAt && now.getTime() - Date.parse(s.startedAt) < STARTUP_GRACE_MS) continue;

    const lastMs = lastActivityMs(svc);
    if (statusState === 'running') {
      if (lastMs === null) {
        if (now.getTime() - Date.parse(state.agentStartedAt) > DEFAULT_CONFIG.stallCritMs) {
          raise({
            rule: 'stalled',
            svc,
            severity: 'critical',
            summary: 'no events ever',
            ttlMs: 15 * 60_000,
            countEvent: false,
            eventTs: state.agentStartedAt,
            text: [
              `🔴 STALLED · ${svc} · ${t(now.toISOString())} Cairo`,
              'status file says running, but this shard has never emitted an event',
              'it was probably started before monitoring existed — restart it',
              'restart with /restart ' + svc
            ].join('\n')
          });
        }
      } else {
        const ageMs = now.getTime() - lastMs;
        if (ageMs > DEFAULT_CONFIG.stallCritMs) {
          raise({
            rule: 'stalled',
            svc,
            severity: 'critical',
            summary: `no events for ${Math.round(ageMs / 60_000)} min`,
            ttlMs: 15 * 60_000,
            countEvent: false,
            eventTs: new Date(lastMs).toISOString(),
            text: [
              `🔴 STALLED · ${svc} · ${t(now.toISOString())} Cairo`,
              `no events for ${Math.round(ageMs / 60_000)} min — the process is dead or hung`,
              `last event: ${s.lastKind || 'unknown'} at ${t(s.lastEventAt)} (${relAge(s.lastEventAt, now.getTime())})`,
              'restart with /restart ' + svc
            ].join('\n')
          });
        } else if (ageMs > DEFAULT_CONFIG.stallWarnMs) {
          raise({
            rule: 'silent',
            svc,
            severity: 'warning',
            summary: `no events for ${Math.round(ageMs / 60_000)} min`,
            ttlMs: 6 * 60_000,
            countEvent: false,
            eventTs: new Date(lastMs).toISOString(),
            text: [
              `🟡 SILENT · ${svc} · ${t(now.toISOString())} Cairo`,
              `no events for ${Math.round(ageMs / 60_000)} min (warn at 5, critical at 15)`,
              `last event: ${s.lastKind || 'unknown'} at ${t(s.lastEventAt)} (${relAge(s.lastEventAt, now.getTime())})`,
              s.batch ? `batch: ${s.batch.accounts.ok}/${s.batch.accounts.ok + s.batch.accounts.failed} accounts · sender ${s.batch.sender}` : 'no batch recorded'
            ].join('\n')
          });
        }
      }

      if (s.batch && !s.batch.endedAt && s.batch.startedAt) {
        const batchAge = now.getTime() - Date.parse(s.batch.startedAt);
        if (batchAge > 5 * 60_000 && s.batch.sender !== 'running') {
          raise({
            rule: 'sender',
            svc,
            severity: 'critical',
            summary: 'realtime sender missing',
            ttlMs: 15 * 60_000,
            countEvent: false,
            eventTs: s.batch.startedAt,
            text: [
              `🔴 SENDER MISSING · ${svc} · ${t(now.toISOString())} Cairo`,
              `batch running ${Math.round(batchAge / 60_000)} min, no realtime sender started`,
              'screenshots are being saved but numbers are not reaching Telegram'
            ].join('\n')
          });
        }
      }
    } else if (statusState === 'cooldown') {
      const nextRunMs = status?.nextRunAt ? Date.parse(status.nextRunAt) : null;
      if (nextRunMs && now.getTime() > nextRunMs + DEFAULT_CONFIG.cooldownOverrunMs) {
        raise({
          rule: 'cooldown',
          svc,
          severity: 'critical',
          summary: 'cooldown overrun',
          ttlMs: 15 * 60_000,
          countEvent: false,
          eventTs: status.nextRunAt,
          text: [
            `🔴 COOLDOWN OVERRUN · ${svc} · ${t(now.toISOString())} Cairo`,
            `cooldown ended ${t(status.nextRunAt)} (${relAge(status.nextRunAt, now.getTime())}), no batch started`,
            'the loop process is probably dead'
          ].join('\n')
        });
      }
    } else if (statusState === 'gated' || statusState === 'probing' || statusState === 'blocked') {
      // Expected silence: the gate is open or the IP is blocked, so no accounts
      // run. The only fault worth waking the admin for is a retry that never
      // happened.
      const nextCheckMs = status?.nextRunAt ? Date.parse(status.nextRunAt) : null;
      if (statusState === 'blocked' && nextCheckMs && now.getTime() > nextCheckMs + 20 * 60_000) {
        raise({
          rule: 'block-retry',
          svc,
          severity: 'critical',
          summary: 'block retry overdue',
          ttlMs: 30 * 60_000,
          countEvent: false,
          eventTs: status.nextRunAt,
          text: [
            `🔴 BLOCK RETRY OVERDUE · ${svc} · ${t(now.toISOString())} Cairo`,
            `the IP-block retry was due ${t(status.nextRunAt)} (${relAge(status.nextRunAt, now.getTime())})`,
            'nothing is scraping while this stays overdue — check site-block.json and the loop log'
          ].join('\n')
        });
      }
      if (statusState === 'gated' && nextCheckMs && now.getTime() > nextCheckMs + 20 * 60_000) {
        const gate = readJson(GATE_FILE);
        raise({
          rule: 'gate-probe',
          svc,
          severity: 'critical',
          summary: 'gate check overdue',
          ttlMs: 30 * 60_000,
          countEvent: false,
          eventTs: status.nextRunAt,
          text: [
            `🔴 GATE CHECK OVERDUE · ${svc} · ${t(now.toISOString())} Cairo`,
            `next vodafone probe was due ${t(status.nextRunAt)} (${relAge(status.nextRunAt, now.getTime())})`,
            gate?.disabled
              ? `gate open since ${t(gate.since)} · ${gate.probeCount || 0} probe(s) so far`
              : 'the gate file says enabled — the shard may be stuck',
            'nothing is scraping while this stays overdue — /gate for state'
          ].join('\n')
        });
      }
    }
  }

  const sync = state.services.sync;
  const lastSync = sync?.sync?.lastDoneAt;
  if (lastSync) {
    const age = now.getTime() - Date.parse(lastSync);
    if (age > DEFAULT_CONFIG.syncSilentMs) {
      raise({
        rule: 'sync-silent',
        svc: 'sync',
        severity: 'critical',
        summary: 'no channel audit',
        ttlMs: 2 * 60 * 60_000,
        countEvent: false,
        eventTs: lastSync,
        text: [
          `🔴 SYNC STOPPED · ${t(now.toISOString())} Cairo`,
          `last channel audit ${relAge(lastSync, now.getTime())} (expected every 6h)`,
          'the ledger is no longer reconciled against the channel'
        ].join('\n')
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Disk, ledger
// ---------------------------------------------------------------------------

function checkDisk() {
  try {
    const stats = statfsSync(ROOT);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    if (totalBytes > 0 && freeBytes < 5 * 1024 ** 3) {
      const gb = (freeBytes / 1024 ** 3).toFixed(1);
      const pct = Math.round((freeBytes / totalBytes) * 100);
      raise({
        rule: 'disk',
        svc: 'monitor',
        severity: 'warning',
        summary: `${gb} GB free`,
        ttlMs: 60 * 60_000,
        countEvent: false,
        text: [
          `🟡 DISK · ${t(new Date().toISOString())} Cairo`,
          `${gb} GB free (${pct}%) on C:`,
          'screenshots and event logs stop writing first'
        ].join('\n')
      });
    }
  } catch {
    // not fatal, skip this pass
  }
}

function checkLedger(now) {
  if (!existsSync(LEDGER_FILE)) return;
  let count;
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_FILE, 'utf8').replace(/^\uFEFF/, ''));
    count = new Set(parsed?.numbers || []).size;
  } catch {
    raise({
      rule: 'ledger-parse',
      svc: 'monitor',
      severity: 'critical',
      summary: 'ledger unreadable',
      ttlMs: 30 * 60_000,
      countEvent: false,
      text: [
        `🔴 LEDGER UNREADABLE · ${t(now.toISOString())} Cairo`,
        LEDGER_FILE,
        'the senders cannot claim numbers — this pauses Telegram delivery'
      ].join('\n')
    });
    return;
  }

  const previous = state.ledger?.count;
  const lastSyncMs = state.services.sync?.sync?.lastDoneAt ? Date.parse(state.services.sync.sync.lastDoneAt) : null;
  const recentSync = lastSyncMs && now.getTime() - lastSyncMs < 10 * 60_000;

  if (typeof previous === 'number' && count < previous - 50 && !recentSync) {
    raise({
      rule: 'ledger-shrink',
      svc: 'monitor',
      severity: 'critical',
      summary: `ledger shrank ${previous - count}`,
      ttlMs: 30 * 60_000,
      text: [
        `🔴 LEDGER SHRANK · ${t(now.toISOString())} Cairo`,
        `${previous} → ${count} (${previous - count} removed) with no channel audit`,
        'numbers may be delivered twice — check with /ledger'
      ].join('\n')
    });
  }

  state.ledger = { count, checkedAt: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Daily proof of life
// ---------------------------------------------------------------------------

function allClearText(now) {
  const d = state.daily || {};
  const buffered = state.suppressed.length;
  const ledger = state.ledger?.count ?? 'unknown';
  const lastSync = state.services.sync?.sync?.lastDoneAt;
  const openIncidents = state.incidents.filter((incident) => !incident.closedAt).length;

  const lines = [
    `✅ all clear · ${day(now.toISOString())} ${t(now.toISOString())}`,
    `overnight: ${d.batches || 0} batches · ${d.numbersSent || 0} numbers · ${d.cooldowns || 0} cooldowns · ${d.syncs || 0} syncs (${d.syncClean || 0} clean)`,
    `buffered warnings: ${buffered}`,
    `ledger ${ledger} · last sync ${lastSync ? `${t(lastSync)} (${relAge(lastSync, now.getTime())})` : 'never'}`,
    `open incidents: ${openIncidents === 0 ? 'none' : openIncidents}`
  ];
  for (const item of state.suppressed.slice(-5)) {
    lines.push(`· ${item.rule} · ${item.svc} at ${t(item.at)}`);
  }
  return lines.join('\n');
}

// Warnings held back by /mute are summarised as soon as the mute is lifted.
// Warnings held back by quiet hours wait for the 09:00 all-clear line.
function checkSuppressedSummary(now) {
  const muted = Boolean(mutedUntil(now));
  const wasMuted = Boolean(state.mutedActive);
  state.mutedActive = muted;
  state.quietActive = isQuietHour(now);

  if (!(wasMuted && !muted)) return;
  if (state.suppressed.length === 0) return;

  const items = state.suppressed.splice(0, state.suppressed.length);
  const lines = [`🟡 buffered while muted · ${items.length} warning(s)`];
  for (const item of items.slice(-10)) lines.push(`· ${item.rule} · ${item.svc} at ${t(item.at)}`);
  pushOutbox({ text: lines.join('\n'), dueAt: now.toISOString() });
}

function checkDailyPing(now) {
  if (!dailyPingDue(state, now)) return;
  const parts = localParts(now);
  pushOutbox({
    text: allClearText(now),
    dueAt: now.toISOString(),
    label: `${String(DEFAULT_CONFIG.dailyPingHour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
  });
  markDailyPing(state, now);
  state.suppressed = [];
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

// One place that announces a closed incident, so expiry and recovery behave
// identically (quiet hours buffer the green line, mute suppresses it).
function announceResolved(incidents, now) {
  if (incidents.length === 0) return;
  const quiet = isQuietHour(now) || mutedUntil(now);
  for (const incident of incidents) {
    if (quiet) {
      noteSuppressed(state, { rule: incident.rule, svc: incident.svc, at: now.toISOString() });
      markResolved(incident);
      continue;
    }
    pushOutbox({ text: resolutionText(incident), dueAt: now.toISOString() });
    markResolved(incident);
  }
}

function closeIncidents(now) {
  announceResolved(expireIncidents(state, now), now);
}

// Closes incidents whose condition a *newer* event has cleared. Expiry alone is
// not enough: melbet resuming must close "silent" immediately, and a number that
// is finally delivered must close its send alert, not 15/30 minutes later.
function resolveIncidents(now, eventTs, predicate) {
  const at = Date.parse(eventTs);
  if (!Number.isFinite(at)) return;
  const resolved = [];
  for (const incident of state.incidents) {
    if (incident.closedAt) continue;
    if (!predicate(incident)) continue;
    if (at <= Date.parse(incident.lastEventAt || '')) continue;
    incident.closedAt = now.toISOString();
    if (incident.alerted) resolved.push(incident);
  }
  announceResolved(resolved, now);
}

// Which event kind clears which rule. Recovery is the rule's own condition
// turning false, not an arbitrary timeout.
function resolveAfterEvent({ kind, svc, ts, data }) {
  const now = new Date();
  const close = (predicate) => resolveIncidents(now, ts, predicate);

  if (kind === 'send.ok') {
    close((incident) =>
      incident.svc === svc &&
      (incident.rule === 'send' || incident.rule === `send-hard:${data.number}`)
    );
  }
  if (kind === 'sender.started') {
    close((incident) => incident.svc === svc && incident.rule === 'sender');
  }
  if (kind === 'batch.start') {
    close((incident) => incident.svc === svc && incident.rule === 'cooldown');
  }
  if (kind === 'sync.done') {
    close((incident) => incident.svc === 'sync');
  }
  // Any event at all proves the service is emitting again.
  close((incident) =>
    incident.svc === svc && (incident.rule === 'silent' || incident.rule === 'stalled')
  );
}

let writing = false;

function persist() {
  if (writing) return;
  writing = true;
  try {
    state.updatedAt = new Date().toISOString();
    pruneState(state);
    writeState(state, STATE_FILE);
  } catch (error) {
    console.error(`[monitor-agent] could not write state: ${error.message}`);
  } finally {
    writing = false;
  }
}

async function tick() {
  const now = new Date();
  rollDailyCounters(state, now);

  // Pending messages from previous ticks are retried with their due label.
  if (state.pendingMessages.length > 0) {
    const pending = state.pendingMessages.splice(0, state.pendingMessages.length);
    for (const message of pending) {
      pushOutbox({ ...message, late: true });
    }
  }

  ingest();
  checkLiveness(now);
  checkDisk();
  checkLedger(now);
  closeIncidents(now);
  checkSuppressedSummary(now);
  checkDailyPing(now);

  await flushOutbox();
  persist();
}

// ---------------------------------------------------------------------------

acquireLock();

let timer = null;
let stopping = false;

async function loop() {
  if (stopping) return;
  try {
    await tick();
  } catch (error) {
    console.error(`[monitor-agent] tick failed: ${error.message}`);
  }
  if (!stopping) timer = setTimeout(loop, TICK_MS);
}

function shutdown() {
  stopping = true;
  if (timer) clearTimeout(timer);
  persist();
  releaseLock();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[monitor-agent] started PID ${process.pid} · state ${STATE_FILE} · events ${path.resolve(ROOT, process.env.EVENTS_DIR || 'events')}`);
console.log(`[monitor-agent] alerts go to admin chat ${chatId || '(none)'} only, never the channel`);

loop();
