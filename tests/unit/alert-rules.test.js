import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  allowAlert,
  canSendPhoto,
  dailyPingDue,
  emptyState,
  expireIncidents,
  isInsideDir,
  isQuietHour,
  localParts,
  markDailyPing,
  markResolved,
  normalizeErrorKey,
  noteAlert,
  notePhoto,
  noteSuppressed,
  pruneState,
  recordError,
  recordFailure,
  rollDailyCounters,
  touchIncident
} from '../../lib/alert-rules.js';

const TZ = 'Africa/Cairo';

const cfg = {
  ...DEFAULT_CONFIG,
  timeZone: TZ,
  stormCount: 5,
  stormWindowMs: 15 * 60_000,
  siteWideWindowMs: 10 * 60_000,
  ruleCooldownMs: 10 * 60_000,
  alertCapPerHour: 30,
  photoCapPerHour: 10,
  quietStartHour: 0,
  quietEndHour: 8,
  dailyPingHour: 9
};

function at(iso) {
  return new Date(iso);
}

test('normalizeErrorKey collapses accounts, numbers, uuids and long ids', () => {
  const a = normalizeErrorKey('Login failed for elgiza7230@gmail.com on 01035054980');
  const b = normalizeErrorKey('Login failed for other@gmail.com on 01099998888');
  assert.equal(a, b);
  assert.ok(a.includes('<account>'));
  assert.ok(a.includes('<number>'));
  assert.ok(normalizeErrorKey('req 123e4567-e89b-12d3-a456-426614174000 failed').includes('<uuid>'));
});

test('recordError counts repeats under one normalized key', () => {
  const state = emptyState();
  recordError(state, { message: 'timeout 01011112222', svc: 'shard-1', ts: '2026-10-29T10:00:00.000Z' });
  recordError(state, { message: 'timeout 01033334444', svc: 'shard-2', ts: '2026-10-29T10:01:00.000Z' });
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].count, 2);
  assert.deepEqual(state.errors[0].svcs.sort(), ['shard-1', 'shard-2']);
});

test('storm needs five failures inside the window', () => {
  const state = emptyState();
  let storm = null;
  for (let i = 0; i < 4; i += 1) {
    const result = recordFailure(state, {
      svc: 'shard-2',
      key: 'login failed',
      ts: `2026-10-29T10:0${i}:00.000Z`,
      cfg
    });
    storm = result.storm;
  }
  assert.equal(storm, null);

  const result = recordFailure(state, {
    svc: 'shard-2',
    key: 'login failed',
    ts: '2026-10-29T10:05:00.000Z',
    cfg
  });
  assert.deepEqual(result.storm, { svc: 'shard-2', count: 5 });
});

test('old failures are pruned out of the storm window', () => {
  const state = emptyState();
  for (let i = 0; i < 4; i += 1) {
    recordFailure(state, { svc: 'shard-1', key: 'x', ts: `2026-10-29T09:0${i}:00.000Z`, cfg });
  }
  // 20 minutes later the earlier four no longer count.
  const result = recordFailure(state, { svc: 'shard-1', key: 'x', ts: '2026-10-29T09:20:00.000Z', cfg });
  assert.equal(result.storm, null);
  assert.equal(state.failures.length, 1);
});

test('the same signature on two services becomes one site-wide event', () => {
  const state = emptyState();
  let siteWide = null;
  const services = ['shard-1', 'shard-1', 'shard-1', 'shard-2', 'shard-2'];
  services.forEach((svc, i) => {
    const result = recordFailure(state, {
      svc,
      key: 'vodafone option not found',
      ts: `2026-10-29T10:0${i}:00.000Z`,
      cfg
    });
    siteWide = result.siteWide || siteWide;
  });
  assert.ok(siteWide);
  assert.deepEqual(siteWide.svcs.sort(), ['shard-1', 'shard-2']);
  assert.equal(siteWide.count, 5);
});

test('quiet hours suppress warnings but never criticals', () => {
  const state = emptyState();
  const night = at('2026-10-29T01:00:00.000Z');
  const quietCfg = { ...cfg, quietStartHour: 0, quietEndHour: 24 };
  assert.equal(isQuietHour(night, quietCfg), true);

  const warning = allowAlert(state, { rule: 'storm', svc: 'shard-1', severity: 'warning', now: night, cfg: quietCfg });
  assert.equal(warning.allowed, false);
  assert.equal(warning.reason, 'quiet-hours');

  const critical = allowAlert(state, { rule: 'stalled', svc: 'shard-1', severity: 'critical', now: night, cfg: quietCfg });
  assert.equal(critical.allowed, true);
});

test('mute suppresses warnings but never criticals', () => {
  const state = emptyState();
  const now = at('2026-10-29T12:00:00.000Z');
  const mutedUntil = new Date(now.getTime() + 60 * 60_000).toISOString();

  const warning = allowAlert(state, { rule: 'send', svc: 'shard-1', severity: 'warning', now, cfg, mutedUntil });
  assert.equal(warning.allowed, false);
  assert.equal(warning.reason, 'muted');

  const critical = allowAlert(state, { rule: 'ledger', svc: 'shard-1', severity: 'critical', now, cfg, mutedUntil });
  assert.equal(critical.allowed, true);
});

test('one alert per rule per cooldown window, then allowed again', () => {
  const state = emptyState();
  const now = at('2026-10-29T12:00:00.000Z');

  assert.equal(allowAlert(state, { rule: 'storm', svc: 'shard-1', now, cfg }).allowed, true);
  noteAlert(state, { rule: 'storm', svc: 'shard-1', now, cfg });

  const blocked = allowAlert(state, { rule: 'storm', svc: 'shard-1', now: at('2026-10-29T12:05:00.000Z'), cfg });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'rule-cooldown');

  const later = allowAlert(state, { rule: 'storm', svc: 'shard-1', now: at('2026-10-29T12:11:00.000Z'), cfg });
  assert.equal(later.allowed, true);
});

test('hourly alert cap stops the flood', () => {
  const state = emptyState();
  const now = at('2026-10-29T12:00:00.000Z');
  for (let i = 0; i < cfg.alertCapPerHour; i += 1) {
    const rule = `rule-${i}`;
    assert.equal(allowAlert(state, { rule, svc: 'shard-1', now, cfg }).allowed, true);
    noteAlert(state, { rule, svc: 'shard-1', now, cfg });
  }
  const blocked = allowAlert(state, { rule: 'one-more', svc: 'shard-1', now, cfg });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'hourly-cap');
});

test('photo cap is ten per Cairo hour', () => {
  const state = emptyState();
  const now = at('2026-10-29T12:00:00.000Z');
  for (let i = 0; i < 10; i += 1) {
    assert.equal(canSendPhoto(state, now, cfg), true);
    notePhoto(state, now, cfg);
  }
  assert.equal(canSendPhoto(state, now, cfg), false);
});

test('incidents open once, refresh on repeats, close after the TTL', () => {
  const state = emptyState();
  const opened = at('2026-10-29T10:00:00.000Z');

  const first = touchIncident(state, {
    rule: 'storm',
    svc: 'shard-2',
    ts: opened.toISOString(),
    ttlMs: 5 * 60_000,
    severity: 'warning',
    summary: 'login failed'
  });
  assert.equal(first.isNew, true);
  assert.equal(state.incidents.length, 1);

  const repeat = touchIncident(state, {
    rule: 'storm',
    svc: 'shard-2',
    ts: at('2026-10-29T10:03:00.000Z').toISOString(),
    ttlMs: 5 * 60_000,
    severity: 'warning'
  });
  assert.equal(repeat.isNew, false);
  assert.equal(state.incidents.length, 1);
  assert.equal(state.incidents[0].count, 2);

  const incident = state.incidents[0];
  incident.alerted = true;

  assert.deepEqual(expireIncidents(state, at('2026-10-29T10:07:00.000Z')), []);
  const resolved = expireIncidents(state, at('2026-10-29T10:09:00.000Z'));
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, 'storm:shard-2');
  markResolved(resolved[0]);
  assert.equal(state.incidents[0].notifiedResolved, true);
});

test('a resolved incident is announced once only', () => {
  const state = emptyState();
  touchIncident(state, { rule: 'disk', svc: 'monitor', ts: '2026-10-29T10:00:00.000Z', ttlMs: 1000 });
  state.incidents[0].alerted = true;
  const first = expireIncidents(state, at('2026-10-29T10:10:00.000Z'));
  assert.equal(first.length, 1);
  markResolved(first[0]);
  const second = expireIncidents(state, at('2026-10-29T10:20:00.000Z'));
  assert.equal(second.length, 0);
});

test('daily ping fires once per Cairo day', () => {
  const state = emptyState();
  const first = at('2026-11-10T07:00:00.000Z');
  const { hour } = localParts(first, TZ);
  const pingCfg = { ...cfg, dailyPingHour: hour };

  assert.equal(dailyPingDue(state, first, pingCfg), true);
  markDailyPing(state, first, pingCfg);
  assert.equal(dailyPingDue(state, first, pingCfg), false);
  assert.equal(dailyPingDue(state, at('2026-11-11T07:00:00.000Z'), pingCfg), true);
});

test('daily counters reset at Cairo midnight', () => {
  const state = emptyState();
  rollDailyCounters(state, at('2026-10-29T10:00:00.000Z'), cfg);
  state.daily.batches = 3;
  rollDailyCounters(state, at('2026-10-29T20:00:00.000Z'), cfg);
  assert.equal(state.daily.batches, 3);
  rollDailyCounters(state, at('2026-10-30T01:00:00.000Z'), cfg);
  assert.equal(state.daily.batches, 0);
});

test('suppressed buffer is bounded', () => {
  const state = emptyState();
  for (let i = 0; i < cfg.maxSuppressed + 10; i += 1) {
    noteSuppressed(state, { rule: 'send', svc: 'shard-1', at: `2026-10-29T10:00:${String(i).padStart(2, '0')}.000Z` });
  }
  assert.equal(state.suppressed.length, cfg.maxSuppressed);
});

test('isInsideDir rejects paths outside the watched folder', () => {
  assert.equal(isInsideDir('C:\\ws\\screenshots\\shard-1\\a.png', 'C:\\ws\\screenshots\\shard-1'), true);
  assert.equal(isInsideDir('C:\\ws\\screenshots\\errors\\a.png', 'C:\\ws\\screenshots\\shard-1'), false);
  assert.equal(isInsideDir('C:\\other\\a.png', 'C:\\ws\\screenshots\\shard-1'), false);
});

test('pruneState keeps the state file bounded', () => {
  const state = emptyState();
  state.errors = new Array(cfg.maxErrors + 5).fill(0).map((_, i) => ({
    key: `e${i}`, count: 1, firstAt: '2026-10-29T10:00:00.000Z', lastAt: '2026-10-29T10:00:00.000Z', svcs: ['shard-1']
  }));
  state.pendingMessages = new Array(cfg.maxPendingMessages + 5).fill({ text: 'x' });
  pruneState(state, at('2026-10-29T10:00:00.000Z'), cfg);
  assert.equal(state.errors.length, cfg.maxErrors);
  assert.equal(state.pendingMessages.length, cfg.maxPendingMessages);
});
