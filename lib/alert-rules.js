// Pure alerting rules. No I/O, no Telegram, no timers — everything is a
// function of (events, state, now) so it can be unit tested.
//
// The agent owns persistence and delivery; this module owns the decisions:
// what counts as a failure, when an alert is allowed through, when an
// incident opens and closes.

import path from 'path';

// 0 is a legitimate value for several of these (no quiet hours, midnight), so
// it must not fall through to the default.
function envInt(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

export const DEFAULT_CONFIG = {
  timeZone: process.env.MONITOR_TZ || 'Africa/Cairo',
  stormCount: envInt('ALERT_STORM_COUNT', 5),
  stormWindowMs: envInt('ALERT_STORM_MINUTES', 15) * 60 * 1000,
  siteWideWindowMs: 10 * 60 * 1000,
  stallWarnMs: envInt('ALERT_STALL_WARN_MINUTES', 5) * 60 * 1000,
  stallCritMs: envInt('ALERT_STALL_MINUTES', 15) * 60 * 1000,
  cooldownOverrunMs: envInt('ALERT_COOLDOWN_OVERRUN_MINUTES', 10) * 60 * 1000,
  ruleCooldownMs: envInt('ALERT_RULE_COOLDOWN_MINUTES', 10) * 60 * 1000,
  alertCapPerHour: envInt('ALERT_CAP_PER_HOUR', 30),
  photoCapPerHour: envInt('ALERT_PHOTO_CAP_PER_HOUR', 10),
  quietStartHour: envInt('ALERT_QUIET_START_HOUR', 0),
  quietEndHour: envInt('ALERT_QUIET_END_HOUR', 8),
  dailyPingHour: envInt('ALERT_DAILY_PING_HOUR', 9),
  malformedLimit: envInt('ALERT_MALFORMED_LIMIT', 20),
  maxErrors: 500,
  maxIncidents: 100,
  maxSuppressed: 50,
  maxPendingMessages: 50
};

export function emptyState() {
  return {
    version: 1,
    updatedAt: null,
    offsets: {},
    services: {},
    failures: [],
    errors: [],
    incidents: [],
    suppressed: [],
    lastAlertByRule: {},
    alertHour: { key: null, count: 0 },
    photoHour: { key: null, count: 0 },
    malformed: 0,
    lastDailyPingDate: null,
    pendingMessages: [],
    mutedActive: false,
    ledger: null,
    daily: { date: null, batches: 0, numbersSent: 0 }
  };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const formatterCache = new Map();

function cairoFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })
    );
  }
  return formatterCache.get(timeZone);
}

// Returns { dateKey: 'YYYY-MM-DD', hour: 0-23, minute: 0-59, hourKey } in the
// configured time zone — independent of the machine clock settings.
export function localParts(now = new Date(), timeZone = DEFAULT_CONFIG.timeZone) {
  const parts = {};
  for (const part of cairoFormatter(timeZone).formatToParts(now)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const hour = Number(parts.hour) % 24;
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    dateKey,
    hour,
    minute: Number(parts.minute),
    hourKey: `${dateKey}T${String(hour).padStart(2, '0')}`
  };
}

export function isQuietHour(now = new Date(), cfg = DEFAULT_CONFIG) {
  const { hour } = localParts(now, cfg.timeZone);
  const { quietStartHour: start, quietEndHour: end } = cfg;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Group identical failures: strip account names, phone numbers, ids and other
// run-specific noise so 200 accounts failing the same way is one row.
export function normalizeErrorKey(message) {
  let key = String(message || 'unknown error').toLowerCase();
  key = key.replace(/[\w.+-]+@[\w.-]+/g, '<account>');
  key = key.replace(/01\d{9}/g, '<number>');
  key = key.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, '<uuid>');
  key = key.replace(/\b\d{3,}\b/g, '<n>');
  key = key.replace(/\s+/g, ' ').trim();
  return key.slice(0, 120) || 'unknown error';
}

export function recordError(state, { message, svc, ts }) {
  const key = normalizeErrorKey(message);
  let entry = state.errors.find((item) => item.key === key);
  if (!entry) {
    entry = { key, count: 0, firstAt: ts, lastAt: ts, svcs: [] };
    state.errors.push(entry);
  }
  entry.count += 1;
  entry.lastAt = ts;
  if (svc && !entry.svcs.includes(svc)) entry.svcs.push(svc);
  if (state.errors.length > DEFAULT_CONFIG.maxErrors) {
    state.errors = state.errors.slice(-DEFAULT_CONFIG.maxErrors);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Failure storm / site-wide block
// ---------------------------------------------------------------------------

export function pruneFailures(state, now, cfg = DEFAULT_CONFIG) {
  const cutoff = now.getTime() - cfg.stormWindowMs;
  state.failures = state.failures.filter((item) => new Date(item.ts).getTime() >= cutoff);
}

// Returns { storm: {svc,count} | null, siteWide: {key,svcs,count} | null }.
export function recordFailure(state, { svc, key, ts, cfg = DEFAULT_CONFIG }) {
  state.failures.push({ svc, key, ts });
  pruneFailures(state, new Date(ts), cfg);

  const windowStart = new Date(ts).getTime() - cfg.stormWindowMs;
  const recent = state.failures.filter((item) => new Date(item.ts).getTime() >= windowStart);

  const perSvc = recent.filter((item) => item.svc === svc).length;
  const storm = perSvc >= cfg.stormCount ? { svc, count: perSvc } : null;

  // Same signature on 2+ services inside the short window = site-wide block.
  const siteStart = new Date(ts).getTime() - cfg.siteWideWindowMs;
  const byKey = new Map();
  for (const item of state.failures) {
    if (new Date(item.ts).getTime() < siteStart) continue;
    const entry = byKey.get(item.key) || { key: item.key, svcs: new Set(), count: 0 };
    entry.svcs.add(item.svc);
    entry.count += 1;
    byKey.set(item.key, entry);
  }
  let siteWide = null;
  for (const entry of byKey.values()) {
    if (entry.svcs.size >= 2 && entry.count >= cfg.stormCount) {
      siteWide = { key: entry.key, svcs: [...entry.svcs].sort(), count: entry.count };
      break;
    }
  }

  return { storm, siteWide };
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export function incidentId(rule, svc) {
  return `${rule}:${svc}`;
}

export function findIncident(state, rule, svc) {
  const id = incidentId(rule, svc);
  return state.incidents.find((item) => item.id === id && !item.closedAt) || null;
}

// Opens (or refreshes) an incident. `isNew` means "first time we see this".
export function touchIncident(state, {
  rule,
  svc,
  ts,
  ttlMs,
  severity = 'warning',
  summary = '',
  countEvent = true
}) {
  const existing = findIncident(state, rule, svc);
  if (existing) {
    existing.lastEventAt = ts;
    existing.expiresAt = new Date(new Date(ts).getTime() + ttlMs).toISOString();
    if (summary) existing.summary = summary;
    if (countEvent) existing.count = (existing.count || 0) + 1;
    return { incident: existing, isNew: false };
  }

  const incident = {
    id: incidentId(rule, svc),
    rule,
    svc,
    severity,
    openedAt: ts,
    lastEventAt: ts,
    expiresAt: new Date(new Date(ts).getTime() + ttlMs).toISOString(),
    count: 1,
    summary,
    alerted: false,
    suppressed: false,
    closedAt: null,
    notifiedResolved: false
  };
  state.incidents.push(incident);
  // Keep every open incident, trim the oldest closed ones.
  const open = state.incidents.filter((item) => !item.closedAt);
  const closed = state.incidents.filter((item) => item.closedAt);
  if (open.length + closed.length > DEFAULT_CONFIG.maxIncidents) {
    const keepClosed = closed.slice(-Math.max(0, DEFAULT_CONFIG.maxIncidents - open.length));
    state.incidents = [...open, ...keepClosed];
  }
  return { incident, isNew: true };
}

// Closes incidents whose condition has not been refreshed. Returns the ones
// that were announced and still need a 🟢 resolution message.
export function expireIncidents(state, now = new Date()) {
  const resolved = [];
  for (const incident of state.incidents) {
    if (incident.closedAt) continue;
    if (new Date(incident.expiresAt).getTime() > now.getTime()) continue;
    incident.closedAt = now.toISOString();
    if (incident.alerted && !incident.notifiedResolved) {
      resolved.push(incident);
    }
  }
  return resolved;
}

export function markResolved(incident) {
  incident.notifiedResolved = true;
}

// ---------------------------------------------------------------------------
// Delivery gating: rate limits, quiet hours, mute
// ---------------------------------------------------------------------------

export function hourlyKey(now = new Date(), cfg = DEFAULT_CONFIG) {
  return localParts(now, cfg.timeZone).hourKey;
}

function nextHourKey(now = new Date(), cfg = DEFAULT_CONFIG) {
  const parts = localParts(now, cfg.timeZone);
  return { key: parts.hourKey, dateKey: parts.dateKey, hour: parts.hour };
}

export function allowAlert(state, { rule, svc, severity = 'warning', now = new Date(), cfg = DEFAULT_CONFIG, mutedUntil = null }) {
  const key = incidentId(rule, svc);
  const nowMs = now.getTime();

  // Mute and quiet hours only hold back warnings. Criticals always pass.
  if (severity !== 'critical') {
    if (mutedUntil && new Date(mutedUntil).getTime() > nowMs) {
      return { allowed: false, reason: 'muted' };
    }
    if (isQuietHour(now, cfg)) {
      return { allowed: false, reason: 'quiet-hours' };
    }
  }

  const hourKey = hourlyKey(now, cfg);
  if (state.alertHour.key !== hourKey) {
    state.alertHour = { key: hourKey, count: 0 };
  }
  if (state.alertHour.count >= cfg.alertCapPerHour) {
    return { allowed: false, reason: 'hourly-cap' };
  }

  const lastMs = state.lastAlertByRule[key];
  if (lastMs && nowMs - lastMs < cfg.ruleCooldownMs) {
    return { allowed: false, reason: 'rule-cooldown' };
  }

  return { allowed: true, reason: 'ok' };
}

export function noteAlert(state, { rule, svc, now = new Date(), cfg = DEFAULT_CONFIG }) {
  const key = incidentId(rule, svc);
  state.lastAlertByRule[key] = now.getTime();
  const hourKey = hourlyKey(now, cfg);
  if (state.alertHour.key !== hourKey) state.alertHour = { key: hourKey, count: 0 };
  state.alertHour.count += 1;
}

export function canSendPhoto(state, now = new Date(), cfg = DEFAULT_CONFIG) {
  const hourKey = hourlyKey(now, cfg);
  if (state.photoHour.key !== hourKey) state.photoHour = { key: hourKey, count: 0 };
  return state.photoHour.count < cfg.photoCapPerHour;
}

export function notePhoto(state, now = new Date(), cfg = DEFAULT_CONFIG) {
  const hourKey = hourlyKey(now, cfg);
  if (state.photoHour.key !== hourKey) state.photoHour = { key: hourKey, count: 0 };
  state.photoHour.count += 1;
}

// Records a warning that was held back, so the morning / unmute summary can
// report it instead of losing it.
export function noteSuppressed(state, { rule, svc, at }) {
  state.suppressed.push({ rule, svc, at });
  if (state.suppressed.length > DEFAULT_CONFIG.maxSuppressed) {
    state.suppressed = state.suppressed.slice(-DEFAULT_CONFIG.maxSuppressed);
  }
}

// ---------------------------------------------------------------------------
// Daily proof-of-life
// ---------------------------------------------------------------------------

export function dailyPingDue(state, now = new Date(), cfg = DEFAULT_CONFIG) {
  const parts = localParts(now, cfg.timeZone);
  if (parts.hour !== cfg.dailyPingHour) return false;
  return state.lastDailyPingDate !== parts.dateKey;
}

export function markDailyPing(state, now = new Date(), cfg = DEFAULT_CONFIG) {
  state.lastDailyPingDate = localParts(now, cfg.timeZone).dateKey;
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

export function rollDailyCounters(state, now = new Date(), cfg = DEFAULT_CONFIG) {
  const { dateKey } = localParts(now, cfg.timeZone);
  if (state.daily.date !== dateKey) {
    state.daily = { date: dateKey, batches: 0, numbersSent: 0 };
  }
}

export function pruneState(state, now = new Date(), cfg = DEFAULT_CONFIG) {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  for (const [key, ts] of Object.entries(state.lastAlertByRule)) {
    if (typeof ts === 'number' && ts < cutoff) delete state.lastAlertByRule[key];
  }
  state.failures = state.failures.filter((item) => new Date(item.ts).getTime() >= now.getTime() - cfg.stormWindowMs * 2);
  if (state.errors.length > cfg.maxErrors) state.errors = state.errors.slice(-cfg.maxErrors);
  if (state.pendingMessages.length > cfg.maxPendingMessages) {
    state.pendingMessages = state.pendingMessages.slice(-cfg.maxPendingMessages);
  }
  if (state.suppressed.length > cfg.maxSuppressed) {
    state.suppressed = state.suppressed.slice(-cfg.maxSuppressed);
  }
  return state;
}

// Helper shared by the agent and the bot to know where a shard's screenshots
// must land. Used by the shot.path rule.
export function isInsideDir(filePath, dirPath) {
  if (!filePath || !dirPath) return true;
  const relative = path.relative(path.resolve(dirPath), path.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
