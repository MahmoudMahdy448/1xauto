// Process-level tests for scripts/monitor-agent.mjs.
//
// Each test starts the real agent against a throwaway workspace, feeds it
// synthetic JSONL events, and asserts on what it sent to a fake Telegram API
// and on the monitor-state.json it wrote. Nothing here touches the real repo,
// the real ledger or the real Telegram.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import path from 'path';
import { startFakeTelegram } from '../helpers/fake-telegram.mjs';
import {
  ROOT,
  baseEnv,
  cairoHour,
  killTree,
  sleep,
  spawnScript,
  tempRoot,
  waitFor,
  writeJson
} from '../helpers/process.mjs';

const CHANNEL = '-1004357023695';
const ADMIN = '699397575';

const isoMinutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function ev(svc, role, kind, data, ts = new Date().toISOString()) {
  return { ts, svc, role, inst: '1', kind, data };
}

function writeEventFile(dir, name, content) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const text = typeof content === 'string' ? content : content.map((line) => `${JSON.stringify(line)}\n`).join('');
  writeFileSync(file, text, 'utf8');
  return file;
}

// Runs the agent once against a fresh workspace and returns what it produced.
async function scenario({ events = {}, files = {}, seed, env = {}, fake = {}, mtimeMinutes, waitMs = 2200, root: fixedRoot } = {}) {
  const root = fixedRoot || tempRoot('agent');
  const tg = await startFakeTelegram(fake);
  const eventsDir = path.join(root, 'events');

  const written = [];
  for (const [name, content] of Object.entries(events)) {
    written.push(writeEventFile(eventsDir, name, content));
  }
  if (mtimeMinutes) {
    const when = new Date(Date.now() - mtimeMinutes * 60_000);
    for (const file of written) utimesSync(file, when, when);
  }

  for (const [name, value] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  if (seed) writeJson(path.join(root, 'monitor-state.json'), seed);

  const child = spawnScript(path.join(ROOT, 'scripts/monitor-agent.mjs'), {
    cwd: root,
    env: baseEnv({ telegramUrl: tg.baseUrl, root, extra: env })
  });

  await sleep(waitMs);
  const statePath = path.join(root, 'monitor-state.json');
  const state = await waitFor(() => {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      return null;
    }
  }, { label: 'monitor-state.json' });

  killTree(child);
  await sleep(150);
  await tg.stop();

  return { root, state, texts: tg.texts(), photos: tg.photos(), calls: tg.calls, output: child.output };
}

function assertAdminOnly(calls) {
  const leaked = calls.filter((call) => call.chatId === CHANNEL);
  assert.deepEqual(leaked, [], 'monitor must never send to the channel');
  for (const call of calls.filter((item) => item.chatId)) {
    assert.equal(call.chatId, ADMIN);
  }
}

test('silent when everything is healthy', async () => {
  const result = await scenario({
    events: {
      'shard-1-loop-1.jsonl': [
        ev('shard-1', 'loop', 'batch.start', { run: 1 }),
        ev('shard-1', 'loop', 'sender.started', {}),
        ev('shard-1', 'scrape', 'account.done', { numbers: 1 }),
        ev('shard-1', 'sender', 'send.ok', { number: '01012345678' })
      ]
    },
    files: { 'loop-status-shard-1.json': { state: 'running' } }
  });

  assert.deepEqual(result.texts, []);
  assert.deepEqual(result.photos, []);
  assert.equal(result.state.services['shard-1'].accounts.ok, 1);
  assert.equal(result.state.services['shard-1'].numbers.sent, 1);
});

test('the first occurrence of an error alerts once, repeats stay silent', async () => {
  const result = await scenario({
    events: {
      'shard-2-scrape-1.jsonl': [1, 2, 3].map(() =>
        ev('shard-2', 'scrape', 'account.failed', { error: 'Login failed: select a login option' })
      )
    }
  });

  assert.equal(result.texts.length, 1, JSON.stringify(result.texts));
  assert.match(result.texts[0], /NEW ERROR/);
  assert.match(result.texts[0], /shard-2/);
  assert.match(result.texts[0], /select a login option/);
  assert.equal(result.state.errors.length, 1);
  assert.equal(result.state.errors[0].count, 3);
  assertAdminOnly(result.calls);
});

test('five failures for one shard produce one storm alert', async () => {
  const result = await scenario({
    waitMs: 2800,
    events: {
      'shard-1-scrape-1.jsonl': [1, 2, 3, 4, 5].map(() =>
        ev('shard-1', 'scrape', 'account.failed', { error: 'Vodafone option not found' })
      )
    }
  });

  const storms = result.texts.filter((text) => text.includes('STORM'));
  assert.equal(storms.length, 1, JSON.stringify(result.texts));
  assert.match(storms[0], /5 failures in 15 min/);
  assert.match(storms[0], /no per-account messages/);
  assert.equal(result.texts.filter((text) => text.includes('NEW ERROR')).length, 1);
});

test('the same error on two shards is reported as one site-wide block', async () => {
  const result = await scenario({
    waitMs: 2800,
    events: {
      'shard-1-scrape-1.jsonl': [1, 2, 3].map(() =>
        ev('shard-1', 'scrape', 'account.failed', { error: 'vodafone option not found within 3 attempts' })
      ),
      'shard-2-scrape-1.jsonl': [1, 2].map(() =>
        ev('shard-2', 'scrape', 'account.failed', { error: 'vodafone option not found within 3 attempts' })
      )
    }
  });

  const siteWide = result.texts.filter((text) => text.includes('SITE-WIDE'));
  assert.equal(siteWide.length, 1, JSON.stringify(result.texts));
  assert.match(siteWide[0], /shard-1, shard-2/);
  assert.match(siteWide[0], /check the site or proxy first/);
});

test('a brand-new error arrives with its screenshot', async () => {
  const root = tempRoot('agent-shot');
  const shot = path.join(root, 'screenshots', 'errors', 'fail.png');
  mkdirSync(path.dirname(shot), { recursive: true });
  writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const result = await scenario({
    root,
    events: {
      'shard-1-scrape-1.jsonl': [
        ev('shard-1', 'scrape', 'step.failed', { error: 'timeout on payment modal', shot }),
        ev('shard-1', 'scrape', 'account.failed', { error: 'timeout on payment modal' })
      ]
    }
  });

  assert.equal(result.photos.length, 1);
  assert.equal(result.photos[0].chatId, ADMIN);
  assert.match(result.photos[0].caption, /NEW ERROR/);
  assert.match(result.photos[0].fileName, /fail\.png/);
  assertAdminOnly(result.calls);
});

test('error screenshots are exempt from the shot.path rule', async () => {
  const root = tempRoot('agent-shot2');
  const outside = path.join(root, 'screenshots', 'errors', 'x.png');
  mkdirSync(path.dirname(outside), { recursive: true });
  writeFileSync(outside, Buffer.from([1, 2, 3]));

  const result = await scenario({
    root,
    events: {
      'shard-1-scrape-1.jsonl': [
        ev('shard-1', 'scrape', 'step.failed', { error: 'modal missing', shot: outside }),
        ev('shard-1', 'scrape', 'account.failed', { error: 'modal missing' })
      ]
    }
  });

  assert.equal(result.texts.filter((text) => text.includes('SHOT PATH')).length, 0);
  assert.equal(result.photos.length, 1);
});

test('the screenshot hourly cap turns the extra alert into text', async () => {
  const root = tempRoot('agent-cap');
  const shotA = path.join(root, 'screenshots', 'errors', 'a.png');
  const shotB = path.join(root, 'screenshots', 'errors', 'b.png');
  mkdirSync(path.dirname(shotA), { recursive: true });
  writeFileSync(shotA, Buffer.from([1]));
  writeFileSync(shotB, Buffer.from([2]));

  const result = await scenario({
    root,
    env: { ALERT_PHOTO_CAP_PER_HOUR: '1' },
    waitMs: 2800,
    events: {
      'shard-1-scrape-1.jsonl': [
        ev('shard-1', 'scrape', 'step.failed', { error: 'first unique failure', shot: shotA }),
        ev('shard-1', 'scrape', 'account.failed', { error: 'first unique failure' }),
        ev('shard-1', 'scrape', 'step.failed', { error: 'second unique failure', shot: shotB }),
        ev('shard-1', 'scrape', 'account.failed', { error: 'second unique failure' })
      ]
    }
  });

  assert.equal(result.photos.length, 1);
  assert.equal(result.texts.filter((text) => text.includes('screenshot suppressed')).length, 1);
});

test('a number screenshot outside the watched folder is critical', async () => {
  const result = await scenario({
    events: {
      'shard-1-scrape-1.jsonl': [ev('shard-1', 'scrape', 'shot.saved', { shot: 'C:\\elsewhere\\01012345678.png' })]
    }
  });

  const pathAlerts = result.texts.filter((text) => text.includes('SHOT PATH'));
  assert.equal(pathAlerts.length, 1);
  assert.match(pathAlerts[0], /realtime-send cannot see it/);
});

test('a number screenshot inside the watched folder is silent', async () => {
  const root = tempRoot('agent-okshot');
  const inside = path.join(root, 'screenshots', 'shard-1', '01012345678.png');
  mkdirSync(path.dirname(inside), { recursive: true });
  writeFileSync(inside, Buffer.from([1]));

  const result = await scenario({
    root,
    events: { 'shard-1-scrape-1.jsonl': [ev('shard-1', 'scrape', 'shot.saved', { shot: inside })] }
  });

  assert.deepEqual(result.texts, []);
});

test('quiet hours hold warnings back but let criticals through', async () => {
  const hour = cairoHour();
  const result = await scenario({
    env: {
      ALERT_QUIET_START_HOUR: String(hour),
      ALERT_QUIET_END_HOUR: String((hour + 1) % 24)
    },
    events: {
      'shard-1-scrape-1.jsonl': [
        ev('shard-1', 'scrape', 'account.failed', { error: 'Login failed: select a login option' }),
        ev('shard-1', 'sender', 'ledger.claim_failed', { error: 'EBUSY lock' })
      ]
    }
  });

  assert.equal(result.texts.filter((text) => text.includes('NEW ERROR')).length, 0);
  assert.equal(result.texts.filter((text) => text.includes('LEDGER')).length, 1);
  assert.ok(result.state.suppressed.length >= 1);
});

test('/mute holds warnings back but lets criticals through', async () => {
  const result = await scenario({
    files: { 'alert-control.json': { mutedUntil: new Date(Date.now() + 60 * 60_000).toISOString() } },
    events: {
      'shard-1-scrape-1.jsonl': [
        ev('shard-1', 'scrape', 'account.failed', { error: 'Login failed: select a login option' }),
        ev('shard-1', 'sender', 'ledger.claim_failed', { error: 'EBUSY lock' })
      ]
    }
  });

  assert.equal(result.texts.filter((text) => text.includes('NEW ERROR')).length, 0);
  assert.equal(result.texts.filter((text) => text.includes('LEDGER')).length, 1);
});

test('the daily all-clear line is sent once per day and reports the counters', async () => {
  const result = await scenario({
    env: { ALERT_DAILY_PING_HOUR: String(cairoHour()) },
    waitMs: 3200,
    events: {
      'shard-1-loop-1.jsonl': [ev('shard-1', 'loop', 'batch.end', { ok: true })],
      'shard-1-sender-1.jsonl': [ev('shard-1', 'sender', 'send.ok', { number: '01012345678' })]
    }
  });

  const allClear = result.texts.filter((text) => text.includes('all clear'));
  assert.equal(allClear.length, 1, JSON.stringify(result.texts));
  assert.match(allClear[0], /ledger/);
  assert.match(allClear[0], /open incidents: none/);
  assert.equal(result.state.lastDailyPingDate.length, 10);
});

test('a running shard whose events stop is reported silent, then stalled', async () => {
  const silent = await scenario({
    env: { ALERT_STALL_WARN_MINUTES: '1', ALERT_STALL_MINUTES: '120' },
    events: { 'shard-1-scrape-1.jsonl': [ev('shard-1', 'scrape', 'step', {}, isoMinutesAgo(5))] },
    files: { 'loop-status-shard-1.json': { state: 'running' } }
  });
  assert.equal(silent.texts.filter((text) => text.includes('SILENT')).length, 1, JSON.stringify(silent.texts));

  const stalled = await scenario({
    env: { ALERT_STALL_WARN_MINUTES: '1', ALERT_STALL_MINUTES: '2' },
    events: { 'shard-1-scrape-1.jsonl': [ev('shard-1', 'scrape', 'step', {}, isoMinutesAgo(20))] },
    files: { 'loop-status-shard-1.json': { state: 'running' } }
  });
  const stalledAlerts = stalled.texts.filter((text) => text.includes('STALLED'));
  assert.equal(stalledAlerts.length, 1, JSON.stringify(stalled.texts));
  assert.match(stalledAlerts[0], /restart with \/restart shard-1/);
});

function openIncident(rule, svc, { minutesAgo = 10, lastEventMinutesAgo = 6, ttlMinutes = 60 } = {}) {
  return {
    id: `${rule}:${svc}`,
    rule,
    svc,
    severity: rule === 'silent' ? 'warning' : 'critical',
    openedAt: isoMinutesAgo(minutesAgo),
    lastEventAt: isoMinutesAgo(lastEventMinutesAgo),
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
    count: 1,
    summary: 'test',
    alerted: true,
    suppressed: false,
    closedAt: null,
    notifiedResolved: false
  };
}

const emptyState = (incidents) => ({
  offsets: {},
  services: {},
  incidents,
  errors: [],
  failures: [],
  suppressed: [],
  pendingMessages: [],
  lastAlertByRule: {},
  alertHour: { key: null, count: 0 },
  photoHour: { key: null, count: 0 }
});

test('a stalled alert closes the moment the service emits another event', async () => {
  const result = await scenario({
    seed: emptyState([openIncident('stalled', 'shard-1', { minutesAgo: 25, lastEventMinutesAgo: 20 })]),
    events: { 'shard-1-scrape-1.jsonl': [ev('shard-1', 'scrape', 'step', {}, isoMinutesAgo(2))] },
    files: { 'loop-status-shard-1.json': { state: 'running' } }
  });

  assert.equal(result.texts.filter((text) => text.includes('STALLED')).length, 0, JSON.stringify(result.texts));
  const resolved = result.texts.filter((text) => text.includes('RESOLVED · shard-1 stalled'));
  assert.equal(resolved.length, 1, JSON.stringify(result.texts));
  assert.match(resolved[0], /^🟢/);

  const incident = result.state.incidents.find((item) => item.rule === 'stalled' && item.svc === 'shard-1');
  assert.ok(incident.closedAt, 'incident must be closed');
  assert.equal(incident.notifiedResolved, true);
});

test('a replayed old event does not close an incident that is still active', async () => {
  // The agent re-reads the tail of recent event files on startup. An event from
  // before the incident was raised must not be mistaken for a recovery.
  const result = await scenario({
    seed: emptyState([openIncident('stalled', 'shard-1', { minutesAgo: 5, lastEventMinutesAgo: 1 })]),
    events: { 'shard-1-scrape-1.jsonl': [ev('shard-1', 'scrape', 'step', {}, isoMinutesAgo(30))] },
    files: { 'loop-status-shard-1.json': { state: 'running' } }
  });

  assert.equal(result.texts.filter((text) => text.includes('RESOLVED · shard-1 stalled')).length, 0);
  const incident = result.state.incidents.find((item) => item.rule === 'stalled' && item.svc === 'shard-1');
  assert.equal(incident.closedAt, null, 'an old event must leave the incident open');
});

test('a delayed number that is finally delivered closes its hard send incident', async () => {
  const result = await scenario({
    seed: emptyState([openIncident('send-hard:01038071584', 'shard-1', { minutesAgo: 12, lastEventMinutesAgo: 6 })]),
    events: {
      'shard-1-sender-1.jsonl': [ev('shard-1', 'sender', 'send.ok', { number: '01038071584' }, isoMinutesAgo(1))]
    }
  });

  const resolved = result.texts.filter((text) => text.includes('RESOLVED · shard-1 send-hard:01038071584'));
  assert.equal(resolved.length, 1, JSON.stringify(result.texts));
  const incident = result.state.incidents.find((item) => item.rule === 'send-hard:01038071584');
  assert.ok(incident.closedAt);
});

test('a running batch without a realtime sender is critical', async () => {
  const result = await scenario({
    events: {
      'shard-1-loop-1.jsonl': [ev('shard-1', 'loop', 'batch.start', { run: 1 }, isoMinutesAgo(10))],
      'shard-1-scrape-1.jsonl': [ev('shard-1', 'scrape', 'account.done', { numbers: 1 })]
    },
    files: { 'loop-status-shard-1.json': { state: 'running' } }
  });

  const sender = result.texts.filter((text) => text.includes('SENDER MISSING'));
  assert.equal(sender.length, 1, JSON.stringify(result.texts));
  assert.match(sender[0], /not reaching Telegram/);
});

test('a cooldown that ends without a new batch is critical', async () => {
  const result = await scenario({
    files: { 'loop-status-shard-2.json': { state: 'cooldown', nextRunAt: isoMinutesAgo(30) } }
  });

  assert.equal(result.texts.filter((text) => text.includes('COOLDOWN OVERRUN')).length, 1);
});

test('a failed channel audit is critical, and a stale audit is reported', async () => {
  const failed = await scenario({
    events: { 'sync-sync-1.jsonl': [ev('sync', 'sync', 'sync.failed', { error: 'AUTH_KEY_UNREGISTERED' })] }
  });
  assert.equal(failed.texts.filter((text) => text.includes('SYNC FAILED')).length, 1);

  const stale = await scenario({
    seed: {
      offsets: {},
      services: { sync: { sync: { lastDoneAt: isoMinutesAgo(20 * 60) } } },
      incidents: [],
      errors: [],
      failures: [],
      suppressed: [],
      pendingMessages: [],
      lastAlertByRule: {},
      alertHour: { key: null, count: 0 },
      photoHour: { key: null, count: 0 }
    }
  });
  assert.equal(stale.texts.filter((text) => text.includes('SYNC STOPPED')).length, 1);
});

test('the ledger is watched for corruption and shrinking', async () => {
  const broken = await scenario({ files: { 'seen-numbers.json': '{ this is not json' } });
  assert.equal(broken.texts.filter((text) => text.includes('LEDGER UNREADABLE')).length, 1);

  const shrunk = await scenario({
    files: { 'seen-numbers.json': { numbers: ['01012345678'] } },
    seed: {
      offsets: {},
      services: {},
      incidents: [],
      errors: [],
      failures: [],
      suppressed: [],
      pendingMessages: [],
      lastAlertByRule: {},
      alertHour: { key: null, count: 0 },
      photoHour: { key: null, count: 0 },
      ledger: { count: 500, checkedAt: isoMinutesAgo(60) }
    }
  });
  assert.equal(shrunk.texts.filter((text) => text.includes('LEDGER SHRANK')).length, 1);
});

test('too many malformed lines are reported once', async () => {
  const broken = ['{ broken', '{ still broken', 'null', ''].join('\n');
  const result = await scenario({
    env: { ALERT_MALFORMED_LIMIT: '2' },
    events: { 'shard-1-scrape-1.jsonl': broken }
  });

  assert.equal(result.texts.filter((text) => text.includes('MALFORMED')).length, 1);
});

test('history from before the agent started is never replayed', async () => {
  const result = await scenario({
    mtimeMinutes: 20,
    events: {
      'shard-1-scrape-1.jsonl': [ev('shard-1', 'scrape', 'account.failed', { error: 'ancient failure' })]
    }
  });

  assert.deepEqual(result.texts, []);
  assert.equal(Object.keys(result.state.services).length, 0);
  assert.equal(Object.keys(result.state.offsets).length, 1);
});

test('a delivery that fails is queued and retried on the next pass', async () => {
  const result = await scenario({
    fake: { failMessageSends: 1 },
    waitMs: 3500,
    events: {
      'shard-1-scrape-1.jsonl': [ev('shard-1', 'scrape', 'account.failed', { error: 'Login failed: select a login option' })]
    }
  });

  const attempts = result.calls.filter((call) => call.kind === 'message');
  assert.ok(attempts.length >= 2, `expected a retry, got ${attempts.length} attempt(s)`);
  assert.equal(result.state.pendingMessages.length, 0, 'queue must drain after a successful retry');
});

test('restarting the agent does not recount the same events', async () => {
  const root = tempRoot('agent-offset');
  const tg = await startFakeTelegram();
  writeEventFile(path.join(root, 'events'), 'shard-1-scrape-1.jsonl', [
    ev('shard-1', 'scrape', 'account.done', { numbers: 1 })
  ]);
  const env = baseEnv({ telegramUrl: tg.baseUrl, root });

  const first = spawnScript(path.join(ROOT, 'scripts/monitor-agent.mjs'), { cwd: root, env });
  await sleep(1400);
  killTree(first);
  await sleep(300);

  const afterFirst = JSON.parse(readFileSync(path.join(root, 'monitor-state.json'), 'utf8'));
  assert.equal(afterFirst.services['shard-1'].accounts.ok, 1);

  const second = spawnScript(path.join(ROOT, 'scripts/monitor-agent.mjs'), { cwd: root, env });
  await sleep(1400);
  killTree(second);
  await sleep(300);

  const afterSecond = JSON.parse(readFileSync(path.join(root, 'monitor-state.json'), 'utf8'));
  assert.equal(afterSecond.services['shard-1'].accounts.ok, 1, 'replayed event was counted twice');
  await tg.stop();
});

test('a stale lock from a dead process is taken over', async () => {
  const root = tempRoot('agent-lock');
  const tg = await startFakeTelegram();
  writeJson(path.join(root, 'monitor-agent.pid'), { pid: 999_999, startedAt: isoMinutesAgo(5) });
  const env = baseEnv({ telegramUrl: tg.baseUrl, root });

  const child = spawnScript(path.join(ROOT, 'scripts/monitor-agent.mjs'), { cwd: root, env });
  await waitFor(() => child.output.stdout.includes('started PID'), { label: 'agent start' });
  await sleep(400);
  const lock = JSON.parse(readFileSync(path.join(root, 'monitor-agent.pid'), 'utf8'));
  assert.equal(lock.pid, child.pid);

  killTree(child);
  await sleep(250);
  await tg.stop();
});

test('a second agent instance refuses to run next to the first', async () => {
  const root = tempRoot('agent-dup');
  const tg = await startFakeTelegram();
  const env = baseEnv({ telegramUrl: tg.baseUrl, root });

  const first = spawnScript(path.join(ROOT, 'scripts/monitor-agent.mjs'), { cwd: root, env });
  await waitFor(() => first.output.stdout.includes('started PID'), { label: 'first agent' });

  const second = spawnScript(path.join(ROOT, 'scripts/monitor-agent.mjs'), { cwd: root, env });
  const code = await new Promise((resolve) => second.on('exit', resolve));
  assert.equal(code, 3);
  assert.match(second.output.stderr, /already running/);

  killTree(first);
  await sleep(250);
  await tg.stop();
});

test('an unreachable Telegram never crashes the agent', async () => {
  const root = tempRoot('agent-down');
  const env = baseEnv({ telegramUrl: 'http://127.0.0.1:1', root });
  writeEventFile(path.join(root, 'events'), 'shard-1-scrape-1.jsonl', [
    ev('shard-1', 'scrape', 'account.failed', { error: 'Login failed: select a login option' })
  ]);

  const child = spawnScript(path.join(ROOT, 'scripts/monitor-agent.mjs'), { cwd: root, env });
  await sleep(2500);
  assert.equal(child.exitCode, null, 'agent must stay alive while Telegram is unreachable');
  const state = JSON.parse(readFileSync(path.join(root, 'monitor-state.json'), 'utf8'));
  assert.ok(state.pendingMessages.length >= 1, 'undelivered alert must be queued');
  killTree(child);
  await sleep(200);
});
