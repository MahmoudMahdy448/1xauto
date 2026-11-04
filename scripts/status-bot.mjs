// status-bot.mjs — the only Telegram poller. Reads monitor-state.json, the
// event logs and the status files, and answers the admin chat.
//
// It never sends to the channel. Every reply is chat text, capped at ~38 lines,
// with Cairo times and relative ages.
//
// Commands: /status /shards /batch /numbers /ledger /timeline /errors
//           /alerts /tail /health /report /restart /mute /unmute /help

import { existsSync, readFileSync, writeFileSync, unlinkSync, statfsSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import {
  getTelegramUpdates,
  sendTelegramMessage,
  sendTelegramDocumentWithRetry
} from '../lib/telegram.js';
import { readState, writeState } from '../lib/state.js';
import { writeLedgerCsv } from '../lib/ledger-export.js';
import { readTail, parseEventLines, listEventFiles } from '../lib/events.js';
import { SERVICE_DEFS, SCRAPE_SERVICES, normalizeServiceName, servicePaths } from '../config/services.js';
import { DEFAULT_CONFIG, localParts } from '../lib/alert-rules.js';

dotenv.config();

const ROOT = process.cwd();
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const adminIds = new Set(
  (process.env.STATUS_ALLOWED_IDS || process.env.TELEGRAM_CHAT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);
const STATE_FILE = path.resolve(ROOT, process.env.MONITOR_STATE_FILE || 'monitor-state.json');
const CONTROL_FILE = path.resolve(ROOT, process.env.ALERT_CONTROL_FILE || 'alert-control.json');
const LEDGER_FILE = path.resolve(ROOT, process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json');
const LOCK_FILE = path.resolve(ROOT, 'status-bot.pid');
const MAX_LINES = 38;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const RESTART_TIMEOUT_MS = (parseInt(process.env.RESTART_VERIFY_SECONDS, 10) || 120) * 1000;
const RESTART_MAX_AGE_MS = (parseInt(process.env.RESTART_ALIVE_SECONDS, 10) || 300) * 1000;
// A command typed while this process was starting is not stale and must be
// answered. Only messages older than this are skipped on startup.
const BACKLOG_MAX_AGE_MS = (() => {
  const seconds = parseInt(process.env.STATUS_BACKLOG_MAX_AGE_SECONDS, 10);
  return (Number.isFinite(seconds) ? seconds : 60) * 1000;
})();

if (!botToken) {
  console.error('TELEGRAM_BOT_TOKEN not set — status bot cannot start.');
  process.exit(1);
}
if (adminIds.size === 0) {
  console.error('TELEGRAM_CHAT_ID not set — status bot has no admin chat to answer.');
  process.exit(1);
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

const t = (iso) => (iso ? timeFmt.format(new Date(iso)) : 'never');
const stamp = (iso) => (iso ? stampFmt.format(new Date(iso)) : 'never');
const day = (iso) => (iso ? dateFmt.format(new Date(iso)) : 'never');

function relAge(iso, nowMs = Date.now()) {
  if (!iso) return 'never';
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'just now';
  if (ms < 0) {
    const ahead = -ms;
    if (ahead < 60_000) return `in ${Math.max(1, Math.round(ahead / 1000))}s`;
    if (ahead < 3_600_000) return `in ${Math.round(ahead / 60_000)} min`;
    const aheadHours = Math.floor(ahead / 3_600_000);
    const aheadMinutes = Math.round((ahead % 3_600_000) / 60_000);
    return aheadMinutes ? `in ${aheadHours}h ${aheadMinutes}m` : `in ${aheadHours}h`;
  }
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

// A bare time is ambiguous once an event is a day old: /tail and /errors can
// span midnight, so anything outside today carries its date.
function sameCairoDay(iso, now = new Date()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  return localParts(new Date(ms)).dateKey === localParts(now).dateKey;
}

function tWhen(iso) {
  if (!iso) return 'never';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'never';
  return sameCairoDay(iso) ? timeFmt.format(new Date(ms)) : stampFmt.format(new Date(ms));
}

// Playwright prefixes some error strings with ANSI colour codes.
const stripAnsi = (text) => String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');

// A service can legitimately emit no events while it is still working: melbet
// and linebet only emit when they find a number. Its stdout log advances once
// per account, so it is the honest heartbeat for that service. For the 1xbet
// shard the log and the events move together, so taking the newer one changes
// nothing.
function serviceActivity(svc) {
  const eventsMs = latestEventMs(svc);
  let logMs = null;
  try {
    logMs = statSync(path.resolve(ROOT, 'logs', `${svc}.log`)).mtimeMs;
  } catch {
    // no log for this service
  }
  if (eventsMs === null && logMs === null) return null;
  if (logMs !== null && (eventsMs === null || logMs > eventsMs)) {
    return { ms: logMs, source: 'log' };
  }
  return { ms: eventsMs, source: 'event' };
}

// Today's/this window's real account and number counts, from the event stream
// rather than the monitor's lifetime counters.
function summarizeEvents(events) {
  const bySvc = new Map();
  const bucket = (svc) => {
    if (!bySvc.has(svc)) {
      bySvc.set(svc, { ok: 0, failed: 0, reads: new Set(), sent: 0, skipped: 0 });
    }
    return bySvc.get(svc);
  };
  for (const event of events) {
    if (!event.svc) continue;
    const stats = bucket(event.svc);
    if (event.kind === 'account.done') stats.ok += 1;
    else if (event.kind === 'account.failed') stats.failed += 1;
    else if (event.kind === 'step' && event.step === 'payment.read_number' && event.data?.number) {
      stats.reads.add(event.data.number);
    } else if (event.kind === 'send.ok') stats.sent += 1;
    else if (event.kind === 'send.skip') stats.skipped += 1;
  }
  return bySvc;
}

// /errors accepts either a time window (6h, 24h, 7d) or a count (5).
function parseErrorArg(arg) {
  const text = String(arg || '').trim().toLowerCase();
  const windowMatch = text.match(/^(\d+)([mhd])$/);
  if (windowMatch) {
    const value = parseInt(windowMatch[1], 10);
    const unit = windowMatch[2];
    const ms = value * (unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 60_000);
    return { windowMs: ms, label: `last ${value}${unit}` };
  }
  const limit = parseInt(text, 10);
  const take = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 25) : 25;
  return { windowMs: null, label: `top ${take}`, take };
}

function cap(text, hint = '') {
  const lines = String(text).split('\n');
  if (lines.length <= MAX_LINES) return lines.join('\n');
  return [...lines.slice(0, MAX_LINES - 1), `… ${hint || 'narrow the range'}`].join('\n');
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readStateFile() {
  return readState(STATE_FILE) || { services: {}, errors: [], incidents: [], suppressed: [] };
}

function serviceState(state, svc) {
  return state.services?.[svc] || {};
}

function latestEventMs(svc) {
  const files = listEventFiles(ROOT).filter((info) => info.name.startsWith(`${svc}-`));
  if (files.length === 0) return null;
  return Math.max(...files.map((info) => info.mtimeMs));
}

function latestEventAge(svc) {
  const ms = latestEventMs(svc);
  return ms === null ? null : Date.now() - ms;
}

// The loop-status file keeps saying "running" after a shard is killed. Trust
// event staleness for running shards, and the cooldown deadline for cooling ones.
function effectiveState(status, ageMs) {
  const loopState = status?.state || 'unknown';
  if (loopState === 'running') {
    if (ageMs !== null && ageMs > 15 * 60_000) return { state: 'stalled', icon: '🔴' };
    if (ageMs !== null && ageMs > 5 * 60_000) return { state: 'silent', icon: '🟡' };
    return { state: 'running', icon: '🟢' };
  }
  if (loopState === 'cooldown') {
    const next = status?.nextRunAt ? Date.parse(status.nextRunAt) : null;
    if (next && Date.now() > next + 10 * 60_000) return { state: 'cooldown overrun', icon: '🔴' };
    return { state: 'cooldown', icon: '🟡' };
  }
  // Gated shards are healthy: they are parked on purpose and only wake for a
  // single-account probe. A check that is far past due is the real problem.
  if (loopState === 'gated') {
    const next = status?.nextRunAt ? Date.parse(status.nextRunAt) : null;
    if (next && Date.now() > next + 15 * 60_000) return { state: 'gate check overdue', icon: '🔴' };
    return { state: 'gated', icon: '🟡' };
  }
  if (loopState === 'probing') return { state: 'probing', icon: '🔵' };
  // Blocked shards are healthy too: 1xbet is refusing every login from this IP,
  // so the loop is parked on purpose. Only an overdue retry is a fault.
  if (loopState === 'blocked') {
    const next = status?.nextRunAt ? Date.parse(status.nextRunAt) : null;
    if (next && Date.now() > next + 20 * 60_000) return { state: 'block retry overdue', icon: '🔴' };
    return { state: 'ip blocked', icon: '🟠' };
  }
  if (loopState === 'waiting') return { state: 'waiting for turn', icon: '🟡' };
  if (loopState === 'idle') return { state: 'idle', icon: '🟢' };
  return { state: loopState, icon: loopState === 'unknown' ? '🟡' : '🔴' };
}

function labelFor(effective, status) {
  if (effective.state === 'cooldown' && status?.nextRunAt && Date.parse(status.nextRunAt) > Date.now()) {
    return `cooldown until ${t(status.nextRunAt)}`;
  }
  if (effective.state === 'gated' && status?.nextRunAt) {
    return `gated · next check ${t(status.nextRunAt)}`;
  }
  if (effective.state === 'ip blocked' && status?.nextRunAt) {
    return `ip blocked · retry ${t(status.nextRunAt)}`;
  }
  return effective.state;
}

function readEvents({ sinceMs = 0, maxAgeMs = 7 * 24 * 3_600_000, tailBytes = 8 * 1024 * 1024 } = {}) {
  const now = Date.now();
  const cutoff = Math.max(sinceMs, now - maxAgeMs);
  const events = [];
  for (const info of listEventFiles(ROOT)) {
    if (info.mtimeMs < cutoff && info.mtimeMs < now - 24 * 3_600_000) continue;
    const { events: parsed } = parseEventLines(readTail(info.file, tailBytes));
    for (const event of parsed) {
      const ts = Date.parse(event.ts);
      if (Number.isFinite(ts) && ts >= cutoff) events.push(event);
    }
  }
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return events;
}

function tailFor(svc, count) {
  // A service writes from more than one process (loop/scrape/sender), so the
  // newest event is not necessarily in the newest file. Merge every recent
  // role file, sort by event time, then take the last N.
  const cutoff = Date.now() - 7 * 24 * 3_600_000;
  const files = listEventFiles(ROOT).filter(
    (info) => info.name.startsWith(`${svc}-`) && info.mtimeMs >= cutoff
  );
  if (files.length === 0) return [];
  const events = [];
  for (const info of files) {
    const { events: parsed } = parseEventLines(readTail(info.file, 64 * 1024));
    events.push(...parsed);
  }
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return events.slice(-count);
}

function eventLine(event, { withSvc = false } = {}) {
  const who = event.account ? ` · ${String(event.account).slice(0, 28)}` : '';
  const step = event.step ? ` ${event.step}` : '';
  const from = withSvc ? `${event.svc} ` : '';
  let detail = '';
  const data = event.data || {};
  if (data.number) detail = ` · ${data.number}`;
  else if (data.error) detail = ` · ${stripAnsi(data.error).slice(0, 60)}`;
  else if (data.shot) detail = ' · screenshot';
  else if (data.ms !== undefined) detail = ` · ${Math.round(Number(data.ms) / 1000)}s`;
  return `${tWhen(event.ts)} ${from}${event.kind}${step}${who}${detail}`;
}

function ledgerInfo() {
  try {
    if (!existsSync(LEDGER_FILE)) return { count: 0, updatedAt: null };
    const parsed = JSON.parse(readFileSync(LEDGER_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return { count: new Set(parsed?.numbers || []).size, updatedAt: parsed?.updatedAt || null };
  } catch {
    return { count: null, updatedAt: null, error: 'unreadable' };
  }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function cmdHelp() {
  return [
    'Admin commands',
    '/status — one line per service',
    '/shards — progress, numbers, failures, silence',
    '/batch — current and last batch per shard',
    '/numbers [today] — extracted, sent, skipped, last 5',
    '/ledger — total and last update',
    '/csv — send every ledger number as a CSV file',
    '/timeline [6h|24h|batch] — milestones',
    '/errors [6h|24h|n] — top error groups',
    '/alerts — incidents with durations',
    '/gate — deposit gate state and next probe',
    '/tail <shard-1|melbet|linebet> [n] — last events',
    '/health — CPU, RAM, disk, uptime',
    '/report [today|24h|batch] — combined summary',
    '/restart <shard-1|linebet> — dead shard only',
    '/mute [30m|2h] / /unmute',
    '/help — this list'
  ].join('\n');
}

function cmdStatus() {
  const state = readStateFile();
  const names = SCRAPE_SERVICES;
  const lines = [`📊 status · ${stamp(new Date().toISOString())} Cairo`];

  for (const svc of names) {
    const s = serviceState(state, svc);
    const paths = servicePaths(svc, ROOT);
    const status = paths?.status ? readJson(paths.status) : null;
    const activity = serviceActivity(svc);
    const ageMs = activity ? Date.now() - activity.ms : null;
    const effective = effectiveState(status || { state: s.state }, ageMs);
    const stateLabel = labelFor(effective, status);
    const age = ageMs === null
      ? 'no activity'
      : `${relAge(new Date(Date.now() - ageMs).toISOString())}${activity.source === 'log' ? ' (log)' : ''}`;
    const lastError = s.lastError ? ` · last error ${tWhen(s.lastError.at)}` : '';
    lines.push(`${effective.icon} ${svc} · ${stateLabel} · ${age}${lastError}`);
  }

  const open = (state.incidents || []).filter((incident) => !incident.closedAt).length;
  lines.push(`open incidents: ${open} · monitor ${state.updatedAt ? relAge(state.updatedAt) : 'never written'}`);
  return cap(lines.join('\n'));
}

function cmdShards() {
  const state = readStateFile();
  const lines = [`🧩 shards · ${stamp(new Date().toISOString())} Cairo`];

  for (const svc of SCRAPE_SERVICES) {
    const s = serviceState(state, svc);
    const paths = servicePaths(svc, ROOT);
    const status = paths?.status ? readJson(paths.status) : null;
    const accountState = paths?.state ? readJson(paths.state) : null;
    const processed = accountState?.lastProcessedIndex;
    const range = SERVICE_DEFS[svc]?.range;
    let progress;
    if (!Number.isFinite(processed)) {
      progress = 'accounts not tracked';
    } else if (range) {
      // lastProcessedIndex is the absolute account index. The single 1xbet
      // shard owns 1-276, so a finished pass reads "#276/276", not unfinished.
      const left = Math.max(0, range[1] - processed);
      progress = `#${processed} · range ${range[0]}–${range[1]}${left === 0 ? ' · done' : ` · ${left} to go`}`;
    } else {
      progress = `#${processed}`;
    }
    const activity = serviceActivity(svc);
    const ageMs = activity ? Date.now() - activity.ms : null;
    const effective = effectiveState(status || { state: s.state }, ageMs);
    const stateLabel = labelFor(effective, status);
    const age = ageMs === null
      ? 'no activity'
      : `${relAge(new Date(Date.now() - ageMs).toISOString())}${activity.source === 'log' ? ' (log)' : ''}`;
    const numbers = s.numbers || { extracted: 0, sent: 0, skipped: 0 };
    const accounts = s.accounts || { ok: 0, failed: 0 };
    // Monitor counters never reset, so they must be labelled as lifetime;
    // otherwise 575 successes look like today's work. melbet and linebet have
    // no state file and emit only send events, so their account/read counts
    // are unknown.
    const tracked = Boolean(paths?.state);
    const accountPart = tracked
      ? `accounts ${accounts.ok} ok / ${accounts.failed} failed`
      : 'send-only service';
    const numberPart = tracked
      ? `numbers ${numbers.extracted} read, ${numbers.sent} sent, ${numbers.skipped} dup`
      : `numbers ${numbers.sent} sent, ${numbers.skipped} dup (reads not tracked)`;
    lines.push(
      `${effective.icon} ${svc} · ${stateLabel} · ${progress} · ${age}`,
      `   ${accountPart} · ${numberPart} (lifetime)`
    );
  }
  return cap(lines.join('\n'));
}

// The monitor counts every payment.read_number event, so retries inflate
// "found" above sent+duplicate. Count distinct numbers inside the batch window
// from the event stream instead, and fall back to the monitor state only when
// no events exist (melbet, linebet and very old batches).
function batchEventNumbers(svc, batch) {
  if (!batch?.startedAt) return null;
  const startMs = Date.parse(batch.startedAt);
  if (!Number.isFinite(startMs)) return null;
  const endMs = batch.endedAt ? Date.parse(batch.endedAt) + 2_000 : Date.now();
  const events = readEvents({ sinceMs: startMs - 1_000 })
    .filter((event) => event.svc === svc && Date.parse(event.ts) <= endMs);
  if (events.length === 0) return null;
  const reads = new Set();
  let sent = 0;
  let skipped = 0;
  for (const event of events) {
    if (event.kind === 'step' && event.step === 'payment.read_number' && event.data?.number) {
      reads.add(event.data.number);
    } else if (event.kind === 'send.ok') {
      sent += 1;
    } else if (event.kind === 'send.skip') {
      skipped += 1;
    }
  }
  return { unique: reads.size, sent, skipped };
}

function describeBatch(svc, batch) {
  if (!batch) return `${svc}: no batch events recorded`;
  const accounts = batch.accounts || { ok: 0, failed: 0 };
  const counted = batchEventNumbers(svc, batch);
  const numbers = counted || batch.numbers || { extracted: 0, sent: 0, skipped: 0 };
  const numberLabel = counted
    ? `${counted.unique} unique`
    : `${numbers.extracted} found`;
  // A screenshot can be captured after the last sender poll. Show the gap
  // instead of making the numbers silently fail to add up.
  const pending = counted ? Math.max(0, counted.unique - counted.sent - counted.skipped) : 0;
  const pendingLabel = pending > 0 ? ` · ${pending} not sent` : '';
  const stateLabel = batch.endedAt
    ? `${batch.ok === false ? '⚠️ failures' : '✅ done'} ${t(batch.endedAt)} · ${batch.durationMs ? duration(batch.durationMs) : 'duration unknown'}`
    : `🟢 running ${relAge(batch.startedAt)}`;
  return [
    `${svc}: ${stateLabel}`,
    `   accounts ${accounts.ok} ok / ${accounts.failed} failed · numbers ${numberLabel}, ${numbers.sent} sent, ${numbers.skipped} dup${pendingLabel} · sender ${batch.sender || 'unknown'}`
  ].join('\n');
}

function cmdBatch() {
  const state = readStateFile();
  const lines = [`📦 batch · ${stamp(new Date().toISOString())} Cairo`];
  for (const svc of SCRAPE_SERVICES) {
    const s = serviceState(state, svc);
    if (s.batch) lines.push(describeBatch(svc, s.batch));
    else if (s.lastBatch) lines.push(`last · ${describeBatch(svc, s.lastBatch)}`);
    else {
      const paths = servicePaths(svc, ROOT);
      const status = paths?.status ? readJson(paths.status) : null;
      const activity = serviceActivity(svc);
      const age = activity ? relAge(new Date(activity.ms).toISOString()) : 'no activity';
      lines.push(`${svc}: no batch events (the scraper emits only send events) · ${status?.state || 'unknown'} · ${age}`);
    }
  }
  return cap(lines.join('\n'));
}

function cmdNumbers(arg = 'today') {
  const parts = localParts();
  // Cairo midnight is not the machine clock; read events and filter by date key.
  const events = readEvents({ sinceMs: Date.now() - 32 * 3_600_000 });
  const todayEvents = events.filter((event) => localParts(new Date(event.ts)).dateKey === parts.dateKey);

  // Reads are emitted only by the 1xbet shard; melbet and linebet send without
  // a read event. Counting reads and sends across different services on one
  // line made the totals impossible to reconcile, so show each service
  // separately.
  const stats = summarizeEvents(todayEvents);
  const delivered = todayEvents.filter((event) => event.kind === 'send.ok');

  const lines = [`🔢 numbers · today (${day(new Date().toISOString())})`];
  for (const svc of SCRAPE_SERVICES) {
    const svcStats = stats.get(svc);
    if (!svcStats) continue;
    const reads = svc === 'melbet' || svc === 'linebet'
      ? 'reads not tracked'
      : `${svcStats.reads.size} unique`;
    lines.push(`${svc}: ${reads} · ${svcStats.sent} sent, ${svcStats.skipped} dup`);
  }
  lines.push(`ledger total ${ledgerInfo().count ?? 'unreadable'}`);
  for (const event of delivered.slice(-5).reverse()) {
    lines.push(`· ${event.data?.number || '?'} at ${t(event.ts)}`);
  }
  if (delivered.length === 0) lines.push('no sends today yet');
  return cap(lines.join('\n'));
}

function cmdLedger() {
  const info = ledgerInfo();
  const lines = [
    `📒 ledger · ${stamp(new Date().toISOString())} Cairo`,
    `numbers: ${info.count === null ? '⚠️ unreadable' : info.count}`,
    `updated: ${info.updatedAt ? `${t(info.updatedAt)} (${relAge(info.updatedAt)})` : 'unknown'}`
  ];
  return cap(lines.join('\n'));
}

// The whole ledger as a file, rebuilt on every request so the admin always
// gets the current state rather than a snapshot from some earlier run.
function exportLedger() {
  return writeLedgerCsv({ ledgerPath: LEDGER_FILE, outDir: path.resolve(ROOT, 'exports') });
}

function ledgerCsvText(out) {
  const kb = Math.max(1, Math.round(out.bytes / 1024));
  return [
    `📄 ledger export · ${stamp(new Date().toISOString())} Cairo`,
    `numbers: ${out.count}`,
    `ledger updated: ${out.updatedAt ? `${t(out.updatedAt)} (${relAge(out.updatedAt)})` : 'unknown'}`,
    `file: ${out.name} (${kb} KB)`
  ].join('\n');
}

function cmdCsv() {
  return ledgerCsvText(exportLedger());
}

async function handleCsv(chatId) {
  const out = exportLedger();
  try {
    await sendTelegramDocumentWithRetry({
      botToken,
      chatId,
      documentPath: out.file,
      caption: ledgerCsvText(out)
    });
    console.log(`[status-bot] sent ledger CSV · ${out.count} number(s) · ${out.bytes} bytes`);
  } catch (error) {
    console.error(`[status-bot] CSV send failed: ${error.message}`);
    await send(chatId, `🔴 could not send the CSV: ${error.message}\nfile on host: ${out.file}`);
  }
}

function rangeMs(arg) {
  if (arg === '24h') return 24 * 3_600_000;
  if (arg === 'batch') return 24 * 3_600_000;
  return 6 * 3_600_000;
}

function cmdTimeline(arg = '6h') {
  const since = Date.now() - rangeMs(arg);
  const events = readEvents({ sinceMs: since });
  const milestones = events.filter((event) =>
    ['batch.start', 'batch.end', 'cooldown.start', 'cooldown.end',
      'sender.started', 'sender.stopped', 'service.started', 'service.stopped'].includes(event.kind)
  );
  const lines = [`🕒 timeline · ${arg} · ${stamp(new Date().toISOString())} Cairo`];
  const selected = milestones.slice(-MAX_LINES + 1);
  for (const event of selected) lines.push(eventLine(event, { withSvc: true }));
  if (milestones.length === 0) lines.push('no milestones in this window');
  return cap(lines.join('\n'));
}

function cmdErrors(arg = '24h') {
  const state = readStateFile();
  const { windowMs, label, take = 25 } = parseErrorArg(arg);
  const cutoff = windowMs ? Date.now() - windowMs : null;
  let errors = [...(state.errors || [])];
  if (cutoff) {
    // "last 24h" must mean last 24h. The old code parsed 24h as the number 24
    // and listed month-old errors as if they were current.
    errors = errors.filter((error) => {
      const last = Date.parse(error.lastAt || error.firstAt);
      return Number.isFinite(last) && last >= cutoff;
    });
  }
  errors.sort((a, b) => b.count - a.count);
  const shown = errors.slice(0, take);
  const lines = [`🐞 errors · ${label} (lifetime counts) · ${stamp(new Date().toISOString())} Cairo`];
  if (shown.length === 0) {
    lines.push(windowMs ? `none recorded in the ${label}` : 'none recorded');
  }
  for (const error of shown) {
    lines.push(
      `${error.count}× ${stripAnsi(error.key).slice(0, 90)}`,
      `   first ${tWhen(error.firstAt)} · last ${tWhen(error.lastAt)} (${relAge(error.lastAt)}) · ${(error.svcs || []).join(', ')}`
    );
  }
  return cap(lines.join('\n'), 'use /errors 10');
}

function cmdAlerts() {
  const state = readStateFile();
  const since = Date.now() - 24 * 3_600_000;
  const incidents = (state.incidents || [])
    .filter((incident) => Date.parse(incident.openedAt) >= since)
    .sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));

  const lines = [`🔔 alerts · 24h · ${stamp(new Date().toISOString())} Cairo`];
  if (incidents.length === 0) lines.push('no incidents in the last 24h');
  for (const incident of incidents.slice(0, 20)) {
    const closed = incident.closedAt ? `closed ${tWhen(incident.closedAt)} · ${duration(Date.parse(incident.closedAt) - Date.parse(incident.openedAt))}` : 'still open';
    const icon = incident.severity === 'critical' ? '🔴' : '🟡';
    lines.push(
      `${icon} ${stripAnsi(incident.rule)} · ${incident.svc} · opened ${tWhen(incident.openedAt)} · ${closed}`,
      `   ${stripAnsi(incident.summary).slice(0, 100)}`
    );
  }
  return cap(lines.join('\n'));
}

function cmdGate() {
  const file = path.resolve(ROOT, process.env.GATE_FILE || 'deposit-gate.json');
  const gate = readJson(file);
  const lines = [`🚧 deposit gate · ${stamp(new Date().toISOString())} Cairo`];

  if (!gate) {
    lines.push('no gate file · vodafone is assumed healthy');
    lines.push(`file: ${path.basename(file)}`);
    return cap(lines.join('\n'));
  }

  if (!gate.disabled) {
    lines.push('✅ vodafone enabled');
    if (gate.since && gate.restoredAt) {
      lines.push(`last outage ${tWhen(gate.since)} → ${tWhen(gate.restoredAt)} (${duration(Date.parse(gate.restoredAt) - Date.parse(gate.since))})`);
    }
    lines.push(`last update ${gate.updatedAt ? tWhen(gate.updatedAt) : 'n/a'}`);
    return cap(lines.join('\n'));
  }

  lines.push(`⛔ vodafone disabled since ${tWhen(gate.since)}`);
  if (gate.reason) lines.push(`"${stripAnsi(gate.reason).slice(0, 120)}"`);
  const who = gate.detectedBy
    ? `${gate.detectedBy.shard || 'unknown'}${gate.detectedBy.account ? ` (${gate.detectedBy.account})` : ''}`
    : 'unknown';
  lines.push(`detected by ${who}`);
  lines.push(`next check ${gate.nextCheckAt ? tWhen(gate.nextCheckAt) : 'n/a'} · ladder step ${gate.ladderIndex || 0}`);
  lines.push(`probes ${gate.probeCount || 0} · failures in a row ${gate.probeFailures || 0}`);
  lines.push(`last checked ${gate.lastCheckedAt ? tWhen(gate.lastCheckedAt) : 'never'}`);
  if (gate.lastProbeError) lines.push(`last probe error: ${stripAnsi(gate.lastProbeError).slice(0, 120)}`);
  return cap(lines.join('\n'));
}

function cmdTail(rest) {
  const match = rest.match(/^(\S+)(?:\s+(\d+))?/);
  const svc = normalizeServiceName(match?.[1]);
  const count = Math.min(parseInt(match?.[2], 10) || 15, 60);
  if (!SERVICE_DEFS[svc]) {
    return 'usage: /tail <shard-1|melbet|linebet> [n]';
  }
  const events = tailFor(svc, count);
  const lines = [`📜 tail ${svc} · last ${events.length} event(s)`];
  for (const event of events) lines.push(eventLine(event));
  if (events.length === 0) lines.push('no events for this service');
  return cap(lines.join('\n'), 'ask for fewer lines');
}

function cmdHealth() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedGb = ((total - free) / 1024 ** 3).toFixed(1);
  const totalGb = (total / 1024 ** 3).toFixed(1);
  let disk = 'unknown';
  try {
    const stats = statfsSync(ROOT);
    const freeDisk = Number(stats.bavail) * Number(stats.bsize);
    const totalDisk = Number(stats.blocks) * Number(stats.bsize);
    disk = `${(freeDisk / 1024 ** 3).toFixed(1)} GB free of ${(totalDisk / 1024 ** 3).toFixed(0)} GB (${Math.round((freeDisk / totalDisk) * 100)}%)`;
  } catch {
    // leave unknown
  }
  const load = os.loadavg()[0];
  // os.loadavg() is always [0,0,0] on Windows, so printing "load 0.00" would
  // report an idle CPU no matter what the machine is doing.
  const cpuLine = process.platform === 'win32'
    ? `CPU ${os.cpus().length} cores`
    : `CPU ${os.cpus().length} cores · load ${load.toFixed(2)}`;
  return cap(
    [
      `🖥 health · ${stamp(new Date().toISOString())} Cairo`,
      cpuLine,
      `RAM ${usedGb} / ${totalGb} GB used`,
      `disk ${disk}`,
      `host uptime ${duration(os.uptime() * 1000)}`,
      `node ${process.version}`
    ].join('\n')
  );
}

function cmdReport(arg = 'today') {
  const state = readStateFile();
  const parts = localParts();
  const since = arg === 'today' ? Date.now() - 32 * 3_600_000 : Date.now() - rangeMs(arg);
  const events = readEvents({ sinceMs: since }).filter((event) =>
    arg === 'today' ? localParts(new Date(event.ts)).dateKey === parts.dateKey : true
  );

  const batches = events.filter((event) => event.kind === 'batch.end');

  // A batch's exit code is not account success: the process can exit 0 while
  // individual accounts failed. Count the failures inside each batch window.
  const openBatches = {};
  let batchesWithFailures = 0;
  let exitErrors = 0;
  for (const event of events) {
    if (event.kind === 'batch.start') {
      openBatches[event.svc] = { failed: 0 };
    } else if (event.kind === 'account.failed' && openBatches[event.svc]) {
      openBatches[event.svc].failed += 1;
    } else if (event.kind === 'batch.end') {
      if (event.data?.ok === false) exitErrors += 1;
      if ((openBatches[event.svc]?.failed || 0) > 0) batchesWithFailures += 1;
      delete openBatches[event.svc];
    }
  }

  const sends = events.filter((event) => event.kind === 'send.ok');
  const open = (state.incidents || []).filter((incident) => !incident.closedAt);
  // Top errors must be the ones seen in this report's window, not the
  // lifetime counters; otherwise a "today" report shows yesterday's outages.
  const inWindow = arg === 'today'
    ? (iso) => sameCairoDay(iso)
    : (iso) => Number.isFinite(Date.parse(iso)) && Date.parse(iso) >= since;
  const top = [...(state.errors || [])]
    .filter((error) => inWindow(error.lastAt || error.firstAt))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  const statsBySvc = summarizeEvents(events);

  const lines = [
    `📊 report · ${arg} · ${stamp(new Date().toISOString())} Cairo`,
    `batches ${batches.length} · ${batchesWithFailures} with failed accounts · ${exitErrors} ended with an error`,
    `numbers sent ${sends.length}`,
    `open incidents ${open.length} · ledger ${ledgerInfo().count ?? 'unreadable'}`
  ];

  for (const svc of SCRAPE_SERVICES) {
    const stats = statsBySvc.get(svc) || { ok: 0, failed: 0, reads: new Set(), sent: 0, skipped: 0 };
    const activity = serviceActivity(svc);
    const age = activity ? `${Math.round((Date.now() - activity.ms) / 1000)}s since activity` : 'no activity';
    const detail = svc === 'melbet' || svc === 'linebet'
      ? `${stats.sent} sent, ${stats.skipped} dup · accounts not tracked`
      : `${stats.ok} ok / ${stats.failed} failed · ${stats.reads.size} unique · ${stats.sent} sent`;
    lines.push(`${svc}: ${detail} · ${age}`);
  }

  if (top.length > 0) {
    lines.push('top errors: (counts are lifetime)');
    for (const error of top) lines.push(`· ${error.count}× ${stripAnsi(error.key).slice(0, 80)}`);
  } else {
    lines.push('top errors: none in this window');
  }
  return cap(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// /restart
// ---------------------------------------------------------------------------

const pendingRestarts = new Set();

function restartDecision(svc) {
  if (!['shard-1', 'linebet'].includes(svc)) {
    return { allowed: false, reason: 'only shard-1 and linebet can be restarted; melbet is off limits' };
  }
  if (pendingRestarts.has(svc)) {
    return { allowed: false, reason: `${svc} restart is already in progress` };
  }

  const paths = servicePaths(svc, ROOT);
  const status = paths?.status ? readJson(paths.status) : null;
  const loopState = status?.state || 'unknown';
  const ageMs = latestEventAge(svc);
  const ageLabel = ageMs === null ? 'no events found' : `last event ${relAge(new Date(Date.now() - ageMs).toISOString())}`;

  // A shard in cooldown is alive even though it has produced no events for up
  // to 90 minutes. Only the loop-status file knows that.
  if (loopState === 'cooldown') {
    const nextMs = status?.nextRunAt ? Date.parse(status.nextRunAt) : null;
    if (nextMs && nextMs > Date.now()) {
      return { allowed: false, reason: `${svc} is cooling down until ${stamp(status.nextRunAt)}` };
    }
    if (nextMs && Date.now() - nextMs < 10 * 60_000) {
      return { allowed: false, reason: `${svc} cooldown ended ${relAge(status.nextRunAt)}, give the loop 10 min` };
    }
    return { allowed: true, reason: `cooldown overran (${ageLabel})` };
  }

  if (loopState === 'waiting') {
    return { allowed: false, reason: `${svc} is waiting for its group turn` };
  }

  // Parked on an IP block: alive, not stuck. Restarting it would only hit the
  // same wall and spend an account.
  if (loopState === 'blocked') {
    const nextMs = status?.nextRunAt ? Date.parse(status.nextRunAt) : null;
    if (nextMs && nextMs > Date.now()) {
      return { allowed: false, reason: `${svc} is parked on an IP block until ${stamp(status.nextRunAt)}` };
    }
    if (nextMs && Date.now() - nextMs < 10 * 60_000) {
      return { allowed: false, reason: `${svc} retry started ${relAge(status.nextRunAt)}, give it 10 min` };
    }
    return { allowed: true, reason: `block retry overran (${ageLabel})` };
  }

  if (ageMs !== null && ageMs < RESTART_MAX_AGE_MS) {
    return { allowed: false, reason: `${svc} is alive — ${ageLabel}` };
  }

  return { allowed: true, reason: loopState === 'running' ? `status says running but ${ageLabel}` : ageLabel };
}

async function handleRestart(chatId, arg) {
  const svc = normalizeServiceName(arg);
  const decision = restartDecision(svc);

  if (!decision.allowed) {
    await send(chatId, `⛔ /restart ${svc} refused\n${decision.reason}`);
    return;
  }

  const launchScript = path.resolve(ROOT, 'scripts', 'launch-shard.ps1');
  if (!existsSync(launchScript)) {
    await send(chatId, `🔴 cannot restart: ${launchScript} is missing`);
    return;
  }

  const env = { ...process.env };
  delete env.BATCH_ID; // a changed BATCH_ID resets the shard to account #1

  pendingRestarts.add(svc);
  const startedAt = Date.now();

  try {
    // Not detached: on Windows a detached powershell can start and exit
    // without running the script. A plain unref'd child still outlives this
    // process, because Windows does not kill children with their parent.
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launchScript, '-Name', svc],
      { cwd: ROOT, stdio: 'ignore', windowsHide: true, env }
    );
    child.unref();
  } catch (error) {
    pendingRestarts.delete(svc);
    await send(chatId, `🔴 restart of ${svc} failed to start: ${error.message}`);
    return;
  }

  await send(chatId, `⏳ restarting ${svc}… (${decision.reason})\nreplies again when it is really back`);

  setTimeout(async () => {
    pendingRestarts.delete(svc);
    const ageMs = latestEventAge(svc);
    const fresh = ageMs !== null && latestEventMs(svc) >= startedAt - 5_000;
    if (fresh) {
      const last = latestEventMs(svc);
      const age = last === null ? 'never' : relAge(new Date(last).toISOString());
      await send(chatId, `✅ ${svc} restarted — last event ${age} · /tail ${svc} 20`);
    } else {
      await send(chatId, `🔴 ${svc} still dead after 2 min — /tail ${svc} 20\ncheck logs\\${svc}.err.log`);
    }
  }, RESTART_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// /mute
// ---------------------------------------------------------------------------

function parseMuteDuration(arg) {
  const match = String(arg || '').trim().match(/^(\d+)\s*(m|h)?$/i);
  if (!match) return 2 * 60 * 60_000;
  const value = parseInt(match[1], 10);
  const unit = (match[2] || 'm').toLowerCase();
  const ms = unit === 'h' ? value * 3_600_000 : value * 60_000;
  return Math.min(Math.max(ms, 60_000), 24 * 3_600_000);
}

async function handleMute(chatId, arg) {
  const ms = parseMuteDuration(arg);
  const until = new Date(Date.now() + ms).toISOString();
  writeState({ mutedUntil: until, updatedAt: new Date().toISOString(), mutedBy: chatId }, CONTROL_FILE);
  await send(chatId, `🔇 muted until ${stamp(until)} Cairo (${duration(ms)})\ncritical alerts still arrive; warnings are buffered`);
}

async function handleUnmute(chatId) {
  writeState({ mutedUntil: null, updatedAt: new Date().toISOString() }, CONTROL_FILE);
  const state = readStateFile();
  const buffered = (state.suppressed || []).length;
  await send(
    chatId,
    `🔊 unmuted\nbuffered warnings while muted: ${buffered}${buffered ? '\nthey will be summarised by the monitor on its next pass' : ''}`
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function send(chatId, text) {
  try {
    await sendTelegramMessage({ botToken, chatId, text: String(text).slice(0, 4096) });
    // One log line per answer: enough to prove from logs that a command was
    // answered, and how many lines it took (the 38-line budget).
    const lines = String(text).split('\n');
    console.log(`[status-bot] replied ${lines.length} line(s) · ${lines[0].slice(0, 90)}`);
  } catch (error) {
    console.error(`[status-bot] send failed: ${error.message}`);
  }
}

function route(text) {
  const trimmed = text.trim();
  const [command, ...restParts] = trimmed.split(/\s+/);
  const rest = restParts.join(' ');
  const name = command.replace(/^\//, '').split('@')[0].toLowerCase();

  switch (name) {
    case 'help':
      return cmdHelp();
    case 'status':
      return cmdStatus();
    case 'shards':
      return cmdShards();
    case 'batch':
      return cmdBatch();
    case 'numbers':
      return cmdNumbers(rest || 'today');
    case 'ledger':
      return cmdLedger();
    case 'csv':
    case 'export':
      return cmdCsv();
    case 'timeline':
      return cmdTimeline(rest || '6h');
    case 'errors':
      return cmdErrors(rest || '24h');
    case 'alerts':
      return cmdAlerts();
    case 'gate':
      return cmdGate();
    case 'tail':
      return cmdTail(rest);
    case 'health':
      return cmdHealth();
    case 'report':
      return cmdReport(rest || 'today');
    default:
      return null;
  }
}

// One-shot mode: `node scripts/status-bot.mjs "/status"` prints exactly what
// the bot would reply, without polling or taking the lock. Useful for checking
// wording and the 38-line cap. Read-only commands only; /restart, /mute and
// /unmute need the live bot because they change state.
const oneShot = process.argv[2];
if (oneShot) {
  const name = oneShot.trim().split(/\s+/)[0].replace(/^\//, '').split('@')[0].toLowerCase();
  if (['restart', 'mute', 'unmute'].includes(name)) {
    console.error(`/${name} cannot run in one-shot mode (it changes state)`);
    process.exit(2);
  }
  const reply = route(oneShot);
  process.stdout.write(`${reply === null ? 'unknown command — /help' : reply}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main loop
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
        console.error(`[status-bot] already running as PID ${lock.pid} — exiting.`);
        process.exit(3);
      }
    }
  } catch {
    // stale lock
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

const commandTimes = new Map();

function rateLimited(chatId) {
  const now = Date.now();
  const times = (commandTimes.get(chatId) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  times.push(now);
  commandTimes.set(chatId, times);
  return times.length > RATE_LIMIT;
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || typeof msg.text !== 'string' || !msg.text.startsWith('/')) return;

  const chatId = String(msg.chat?.id ?? '');
  if (!adminIds.has(chatId)) {
    console.log(`[status-bot] ignoring command from unauthorized chat ${chatId}`);
    return;
  }

  const text = msg.text.trim();
  console.log(`[status-bot] ${text} from ${chatId}`);

  if (rateLimited(chatId)) {
    await send(chatId, '⏳ too many commands (20/min) — wait a minute');
    return;
  }

  const [command, ...restParts] = text.split(/\s+/);
  const name = command.replace(/^\//, '').split('@')[0].toLowerCase();
  const rest = restParts.join(' ');

  try {
    if (name === 'restart') {
      await handleRestart(chatId, rest);
      return;
    }
    if (name === 'mute') {
      await handleMute(chatId, rest);
      return;
    }
    if (name === 'unmute') {
      await handleUnmute(chatId);
      return;
    }
    if (name === 'csv' || name === 'export') {
      await handleCsv(chatId);
      return;
    }

    const reply = route(text);
    if (reply === null) {
      await send(chatId, 'unknown command — /help');
      return;
    }
    await send(chatId, reply);
  } catch (error) {
    console.error(`[status-bot] ${name} failed: ${error.message}`);
    await send(chatId, `🔴 ${name} failed: ${error.message}`);
  }
}

acquireLock();

console.log(`[status-bot] started PID ${process.pid} · admin chats ${[...adminIds].join(', ')}`);
console.log('[status-bot] only poller: the monitor agent never calls getUpdates');

let offset = 0;
let stopping = false;

function shutdown() {
  stopping = true;
  releaseLock();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Commands typed while the bot was down must not run on startup (an old
// /restart would be a surprise). Look at the newest pending update and, if it
// is old, resume polling after it. A message from the last minute is left
// alone: it may have been typed while this process was starting.
async function drainBacklog() {
  try {
    const updates = await getTelegramUpdates({ botToken, offset: -1, timeoutSeconds: 0 });
    const newest = updates[updates.length - 1];
    if (!newest) return;
    const sentAt = Number(newest.message?.date ?? newest.edited_message?.date ?? 0) * 1000;
    const ageMs = Date.now() - sentAt;
    if (ageMs < BACKLOG_MAX_AGE_MS) {
      // Fresh: answer it, but do not replay anything queued before it.
      offset = newest.update_id;
      return;
    }
    offset = newest.update_id + 1;
    console.log(`[status-bot] skipped 1 stale command from while it was down`);
  } catch (error) {
    console.error(`[status-bot] could not drain backlog: ${error.message}`);
  }
}

await drainBacklog();

while (!stopping) {
  try {
    const updates = await getTelegramUpdates({ botToken, offset, timeoutSeconds: 30 });
    for (const update of updates) {
      offset = update.update_id + 1;
      await handleUpdate(update);
    }
  } catch (error) {
    console.error(`[status-bot] getUpdates error (retrying in 5s): ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
