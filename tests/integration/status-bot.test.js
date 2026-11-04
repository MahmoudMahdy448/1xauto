// Process-level tests for scripts/status-bot.mjs.
//
// The bot is the only process that calls getUpdates, so these tests drive it
// exactly like Telegram does: commands are queued on a fake Bot API, and the
// replies it produces are asserted. Every command, the auth check, the rate
// limit and all /restart guards are covered.
//
// The workspace is a temp directory, so /restart runs a fake launch-shard.ps1
// instead of touching the real shards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { startFakeTelegram } from '../helpers/fake-telegram.mjs';
import {
  ROOT,
  baseEnv,
  killTree,
  sleep,
  spawnScript,
  tempRoot,
  waitFor,
  writeJson
} from '../helpers/process.mjs';
import { localParts } from '../../lib/alert-rules.js';

const ADMIN = '699397575';
const CHANNEL = '-1004357023695';

const nowIso = () => new Date().toISOString();
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function today(moment = new Date()) {
  return localParts(moment).dateKey;
}

function eventFile(dir, name, events) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), events.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8');
}

const LAUNCHER_OK = `param([string]$Name, [switch]$Resume)
New-Item -ItemType Directory -Force -Path 'events' | Out-Null
Set-Content -Path 'launcher-ran.txt' -Value ("name=$Name batchId=$($env:BATCH_ID) resume=$Resume")
Set-Content -Path ('events\\' + $Name + '-restarted.jsonl') -Value ('{"ts":"' + (Get-Date).ToUniversalTime().ToString('o') + '","svc":"' + $Name + '","role":"loop","inst":"1","kind":"service.started","data":{}}')
`;

const LAUNCHER_DEAD = `param([string]$Name, [switch]$Resume)
Set-Content -Path 'launcher-ran.txt' -Value ("name=$Name batchId=$($env:BATCH_ID) resume=$Resume")
`;

// A workspace that looks like a healthy mid-batch repo.
function seedWorkspace(root, { launcher = LAUNCHER_OK, statusShard1 = { state: 'running' } } = {}) {
  ensureDirs(root);
  writeJson(path.join(root, 'monitor-state.json'), {
    updatedAt: nowIso(),
    services: {
      'shard-1': {
        state: 'running',
        lastEventAt: nowIso(),
        lastKind: 'step',
        accounts: { ok: 12, failed: 1 },
        numbers: { extracted: 12, sent: 11, skipped: 1 },
        batch: {
          id: 'batch-1',
          startedAt: minutesAgo(20),
          endedAt: null,
          ok: null,
          sender: 'running',
          accounts: { ok: 12, failed: 1 },
          numbers: { extracted: 12, sent: 11, skipped: 1 }
        },
        lastError: { message: 'Login failed: select a login option', at: minutesAgo(6) }
      },
      linebet: {
        state: 'cooldown',
        lastEventAt: minutesAgo(30),
        accounts: { ok: 40, failed: 2 },
        numbers: { extracted: 38, sent: 35, skipped: 3 }
      },
      melbet: {
        state: 'running',
        lastEventAt: nowIso(),
        accounts: { ok: 5, failed: 0 },
        numbers: { extracted: 5, sent: 5, skipped: 0 }
      }
    },
    errors: [
      {
        key: 'login failed: select a login option',
        count: 3,
        firstAt: minutesAgo(30),
        lastAt: minutesAgo(6),
        svcs: ['shard-1', 'linebet']
      }
    ],
    incidents: [
      {
        id: 'storm:shard-1',
        rule: 'storm',
        svc: 'shard-1',
        severity: 'warning',
        openedAt: minutesAgo(40),
        closedAt: null,
        expiresAt: minutesAgo(-20),
        count: 5,
        summary: 'login failed',
        alerted: true,
        notifiedResolved: false
      },
      {
        id: 'stalled:linebet',
        rule: 'stalled',
        svc: 'linebet',
        severity: 'critical',
        openedAt: minutesAgo(300),
        closedAt: minutesAgo(280),
        count: 1,
        summary: 'no events for 20 min',
        alerted: true,
        notifiedResolved: true
      }
    ],
    suppressed: [],
    pendingMessages: []
  });

  writeJson(path.join(root, 'loop-status-shard-1.json'), statusShard1);
  writeJson(path.join(root, 'linebet', 'loop-status.json'), {
    state: 'cooldown',
    nextRunAt: new Date(Date.now() + 45 * 60_000).toISOString()
  });
  writeJson(path.join(root, 'loop-status.json'), { state: 'running' });
  writeJson(path.join(root, 'state-shard-1.json'), { lastProcessedIndex: 90, totalAccounts: 276 });
  writeJson(path.join(root, 'seen-numbers.json'), { updatedAt: nowIso(), numbers: ['01011112222', '01033334444'] });
  writeFileSync(path.join(root, 'scripts', 'launch-shard.ps1'), launcher);

  eventFile(path.join(root, 'events'), 'shard-1-loop-1.jsonl', [
    { ts: minutesAgo(20), svc: 'shard-1', role: 'loop', inst: '1', kind: 'batch.start', data: { run: 1 } },
    { ts: minutesAgo(19), svc: 'shard-1', role: 'loop', inst: '1', kind: 'sender.started', data: {} },
    { ts: minutesAgo(10), svc: 'shard-1', role: 'loop', inst: '1', kind: 'batch.end', data: { ok: false } }
  ]);
  eventFile(path.join(root, 'events'), 'shard-1-scrape-1.jsonl', [
    { ts: minutesAgo(18), svc: 'shard-1', role: 'scrape', inst: '1', kind: 'step', step: 'payment.read_number', account: 'a@b.c', data: { number: '01011112222' } },
    { ts: minutesAgo(17), svc: 'shard-1', role: 'scrape', inst: '1', kind: 'step', step: 'payment.read_number', account: 'c@d.e', data: { number: '01033334444' } },
    { ts: minutesAgo(16), svc: 'shard-1', role: 'scrape', inst: '1', kind: 'account.done', account: 'a@b.c', data: { ms: 42000, numbers: 1 } },
    { ts: minutesAgo(13), svc: 'shard-1', role: 'scrape', inst: '1', kind: 'account.failed', account: 'x@y.z', data: { error: 'login failed', step: 'login' } }
  ]);
  eventFile(path.join(root, 'events'), 'shard-1-sender-1.jsonl', [
    { ts: minutesAgo(15), svc: 'shard-1', role: 'sender', inst: '1', kind: 'send.ok', data: { number: '01011112222' } },
    { ts: minutesAgo(14), svc: 'shard-1', role: 'sender', inst: '1', kind: 'send.skip', data: { number: '01033334444', reason: 'already-seen' } }
  ]);
}

function ensureDirs(root) {
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'events'), { recursive: true });
}

async function startBot(root, tg, { env = {}, backlog = [], backlogAgeSeconds = 0 } = {}) {
  for (const text of backlog) {
    tg.enqueue(text, ADMIN, Math.floor(Date.now() / 1000) - backlogAgeSeconds);
  }
  const child = spawnScript(path.join(ROOT, 'scripts/status-bot.mjs'), {
    cwd: root,
    env: baseEnv({
      telegramUrl: tg.baseUrl,
      root,
      extra: {
        RESTART_VERIFY_SECONDS: '2',
        STATUS_BOT_PID: path.join(root, 'status-bot.pid'),
        ...env
      }
    })
  });
  await waitFor(() => child.output.stdout.includes('started PID'), { label: 'status-bot start' });
  return child;
}

async function ask(tg, text, { chatId = ADMIN } = {}) {
  const before = tg.messages().length;
  tg.enqueue(text, chatId);
  await waitFor(() => tg.messages().length > before, { label: `reply to ${text}` });
  await sleep(150);
  return tg.messages().slice(before).map((message) => message.text);
}

async function withBot(run, options = {}) {
  const root = tempRoot('bot');
  const tg = await startFakeTelegram();
  if (options.seed !== false) seedWorkspace(root, options.seedOptions);
  const child = await startBot(root, tg, options);
  try {
    await run({ root, tg, child });
  } finally {
    killTree(child);
    await sleep(150);
    await tg.stop();
  }
  return { root, tg };
}

test('/help lists the whole command surface', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/help');
    for (const command of ['/status', '/shards', '/batch', '/numbers', '/ledger', '/csv', '/timeline', '/errors', '/alerts', '/tail', '/health', '/report', '/restart', '/mute', '/unmute']) {
      assert.ok(reply.includes(command), `missing ${command} in /help`);
    }
  });
});

test('/status summarises every service with Cairo time and its effective state', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/status');
    assert.match(reply, /status · .* Cairo/);
    assert.match(reply, /🟢 shard-1 · running/);
    assert.match(reply, /🟡 linebet · cooldown/);
    assert.match(reply, /melbet/);
    assert.match(reply, /open incidents: 1/);
  });
});

test('/shards shows progress, accounts and numbers per shard', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/shards');
    assert.match(reply, /shard-1 · running · #90 · range 1–276 · 186 to go/);
    assert.match(reply, /accounts 12 ok \/ 1 failed/);
    assert.match(reply, /12 read, 11 sent, 1 dup/);
    assert.match(reply, /linebet · cooldown(?: until \d{2}:\d{2})? · accounts not tracked/);
  });
});

test('/batch describes the live batch and the sender', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/batch');
    assert.match(reply, /shard-1: 🟢 running/);
    assert.match(reply, /sender running/);
    assert.match(reply, /no batch events/); // melbet, derived from events only
  });
});

test('/numbers counts today from the event stream', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/numbers');
    assert.match(reply, /numbers · today/);
    assert.match(reply, /shard-1: 2 unique · 1 sent, 1 dup/);
    assert.match(reply, /ledger total 2/);
    assert.match(reply, /01011112222 at \d{2}:\d{2}/);
  });
});

test('/ledger reports the total and when it last changed', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/ledger');
    assert.match(reply, /numbers: 2/);
    assert.match(reply, /updated: \d{2}:\d{2}/);
  });
});

test('/csv sends the whole ledger as a CSV file', async () => {
  await withBot(async ({ tg }) => {
    tg.enqueue('/csv');
    await waitFor(() => tg.documents().length > 0, { label: 'ledger CSV document' });
    const [doc] = tg.documents();
    assert.equal(doc.chatId, ADMIN, 'the file goes to the admin chat');
    assert.match(doc.fileName, /^ledger-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/);
    assert.match(doc.caption, /ledger export/);
    assert.match(doc.caption, /numbers: 2/);
    const rows = doc.body.trim().split('\r\n');
    assert.equal(rows[0], 'number', 'the file has a header row');
    assert.deepEqual(rows.slice(1), ['01011112222', '01033334444'], 'every ledger number, sorted');
  });
});

test('/timeline lists milestones with the service they belong to', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/timeline 6h');
    assert.match(reply, /timeline · 6h/);
    assert.match(reply, /(?:[A-Z][a-z]{2} \d{2}, )?\d{2}:\d{2} shard-1 batch\.start/);
    assert.match(reply, /(?:[A-Z][a-z]{2} \d{2}, )?\d{2}:\d{2} shard-1 batch\.end/);
    assert.ok(!reply.includes('payment.read_number'), 'steps must not appear in the timeline');
  });
});

test('/errors groups by signature with first and last seen', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/errors');
    assert.match(reply, /3× login failed: select a login option/);
    assert.match(reply, /first (?:[A-Z][a-z]{2} \d{2}, )?\d{2}:\d{2} · last (?:[A-Z][a-z]{2} \d{2}, )?\d{2}:\d{2}/);
    assert.match(reply, /shard-1, linebet/);
  });
});

test('/alerts shows open and resolved incidents with their duration', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/alerts');
    assert.match(reply, /storm · shard-1 · opened .* · still open/);
    assert.match(reply, /stalled · linebet .*closed .* · 20 min/);
  });
});

test('/tail merges every role file for the service', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/tail shard-1 5');
    assert.match(reply, /tail shard-1 · last \d+ event/);
    // loop, scrape and sender are separate files: the newest events come from
    // all three, not just the last file that happened to be written.
    assert.match(reply, /batch\.end/);
    assert.match(reply, /account\.failed/);
    assert.match(reply, /send\.ok/);
    const [bad] = await ask(tg, '/tail nope 3');
    assert.match(bad, /usage: \/tail/);
  });
});

test('/health reports memory, disk and runtime', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/health');
    assert.match(reply, /CPU \d+ cores/);
    assert.match(reply, /RAM .* GB used/);
    assert.match(reply, /disk .* GB free/);
    assert.match(reply, /node v\d+/);
  });
});

test('/report combines the picture into one summary', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/report today');
    assert.match(reply, /report · today/);
    assert.match(reply, /batches 1 · 1 with failed accounts · 1 ended with an error/);
    assert.match(reply, /numbers sent 1/);
    assert.match(reply, /shard-1: 1 ok \/ 1 failed/);
    assert.match(reply, /top errors:/);
  });
});

test('an unknown command points at /help', async () => {
  await withBot(async ({ tg }) => {
    const [reply] = await ask(tg, '/dance');
    assert.match(reply, /unknown command/);
  });
});

test('commands from any other chat are ignored completely', async () => {
  await withBot(async ({ tg }) => {
    const before = tg.messages().length;
    tg.enqueue('/mute 60m', '123456');
    await sleep(1200);
    assert.equal(tg.messages().length, before, 'an unauthorized chat must not get a reply');
  });
});

test('replies never exceed the 38-line budget', async () => {
  const root = tempRoot('bot-long');
  const tg = await startFakeTelegram();
  seedWorkspace(root);
  const many = [];
  for (let i = 0; i < 80; i += 1) {
    many.push({
      ts: minutesAgo(10 - i / 60),
      svc: 'shard-1',
      role: 'scrape',
      inst: '1',
      kind: 'step',
      step: 'login.page_open',
      account: `acc${i}@example.com`
    });
  }
  eventFile(path.join(root, 'events'), 'shard-1-scrape-1.jsonl', many);
  const child = await startBot(root, tg);
  try {
    const [reply] = await ask(tg, '/tail shard-1 60');
    assert.ok(reply.split('\n').length <= 38, `reply had ${reply.split('\n').length} lines`);
  } finally {
    killTree(child);
    await sleep(150);
    await tg.stop();
  }
});

test('more than 20 commands in a minute are rate limited', async () => {
  await withBot(async ({ tg }) => {
    for (let i = 0; i < 20; i += 1) await ask(tg, '/help');
    const [reply] = await ask(tg, '/help');
    assert.match(reply, /too many commands/);
  });
});

test('/mute writes the control file and /unmute clears it', async () => {
  await withBot(async ({ root, tg }) => {
    const [muted] = await ask(tg, '/mute 30m');
    assert.match(muted, /🔇 muted until .* Cairo \(30 min\)/);
    assert.match(muted, /critical alerts still arrive/);

    const control = JSON.parse(readFileSync(path.join(root, 'alert-control.json'), 'utf8'));
    assert.ok(Date.parse(control.mutedUntil) > Date.now());

    const [unmuted] = await ask(tg, '/unmute');
    assert.match(unmuted, /🔊 unmuted/);
    const cleared = JSON.parse(readFileSync(path.join(root, 'alert-control.json'), 'utf8'));
    assert.equal(cleared.mutedUntil, null);
  });
});

test('/restart refuses melbet and any shard that is still alive', async () => {
  await withBot(async ({ root, tg }) => {
    const [melbet] = await ask(tg, '/restart melbet');
    assert.match(melbet, /off limits/);

    const [alive] = await ask(tg, '/restart shard-1');
    assert.match(alive, /is alive/);

    assert.equal(tg.messages().filter((message) => message.text.includes('restarting')).length, 0);
    assert.ok(!readFileSync(path.join(root, 'launcher-ran.txt'), { encoding: 'utf8', flag: 'a+' }).length);
  });
});

test('/restart refuses a shard that is still cooling down', async () => {
  await withBot(async ({ root, tg }) => {
    const [cooling] = await ask(tg, '/restart linebet');
    assert.match(cooling, /cooling down until/);

    assert.equal(tg.messages().filter((message) => message.text.includes('restarting')).length, 0);
    assert.ok(!readFileSync(path.join(root, 'launcher-ran.txt'), { encoding: 'utf8', flag: 'a+' }).length);
  });
});

test('/restart starts a dead shard and confirms when events resume', async () => {
  const root = tempRoot('bot-restart');
  seedWorkspace(root);
  // No events and no status file for linebet: it looks dead.
  writeFileSync(path.join(root, 'linebet', 'loop-status.json'), JSON.stringify({ state: 'unknown' }));
  writeJson(path.join(root, 'monitor-state.json'), { updatedAt: nowIso(), services: {}, errors: [], incidents: [], suppressed: [] });

  const tg = await startFakeTelegram();
  // PowerShell can take a couple of seconds to start and run the launcher, so
  // give the shard a wide window to come back before the bot calls it dead.
  const child = await startBot(root, tg, { env: { RESTART_VERIFY_SECONDS: '8' } });
  try {
    const [started] = await ask(tg, '/restart linebet');
    assert.match(started, /restarting linebet/);

    await waitFor(() => {
      try {
        return readFileSync(path.join(root, 'launcher-ran.txt'), 'utf8');
      } catch {
        return null;
      }
    }, { label: 'fake launcher ran' });

    const ran = readFileSync(path.join(root, 'launcher-ran.txt'), 'utf8');
    assert.match(ran, /name=linebet/);
    assert.match(ran, /batchId= /, 'BATCH_ID must never be passed to the launcher');
    assert.ok(!ran.includes('batchId=20'), 'BATCH_ID leaked from the bot environment');

    const confirmed = await waitFor(() => {
      const texts = tg.messages().map((message) => message.text);
      return texts.find((text) => text.includes('✅') || text.includes('still dead'));
    }, { label: 'restart confirmation', timeout: 12_000 });
    assert.match(confirmed, /✅/);
  } finally {
    killTree(child);
    await sleep(150);
    await tg.stop();
  }
});

test('/restart reports a shard that never comes back', async () => {
  const root = tempRoot('bot-restart-dead');
  seedWorkspace(root, { launcher: LAUNCHER_DEAD });
  writeFileSync(path.join(root, 'linebet', 'loop-status.json'), JSON.stringify({ state: 'unknown' }));

  const tg = await startFakeTelegram();
  const child = await startBot(root, tg);
  try {
    const [started] = await ask(tg, '/restart linebet');
    assert.match(started, /restarting linebet/);

    const failed = await waitFor(() => {
      const texts = tg.messages().map((message) => message.text);
      return texts.find((text) => text.includes('still dead'));
    }, { label: 'dead confirmation', timeout: 8000 });
    assert.match(failed, /check logs\\linebet\.err\.log/);
  } finally {
    killTree(child);
    await sleep(150);
    await tg.stop();
  }
});

test('commands queued while the bot was down are skipped, not executed', async () => {
  const root = tempRoot('bot-backlog');
  seedWorkspace(root);
  const tg = await startFakeTelegram();
  const child = await startBot(root, tg, { backlog: ['/mute 60m'], backlogAgeSeconds: 600 });
  try {
    await sleep(800);
    assert.equal(tg.messages().length, 0, 'a stale command must not run');
    let control = null;
    try {
      control = readFileSync(path.join(root, 'alert-control.json'), 'utf8');
    } catch {
      control = null;
    }
    assert.equal(control, null);
    assert.match(child.output.stdout, /skipped 1 stale command/);
  } finally {
    killTree(child);
    await sleep(150);
    await tg.stop();
  }
});

test('a command sent while the bot is starting is still answered', async () => {
  const root = tempRoot('bot-fresh');
  seedWorkspace(root);
  const tg = await startFakeTelegram();
  // Queued before the process exists, but only seconds old: not stale.
  tg.enqueue('/ledger', ADMIN, Math.floor(Date.now() / 1000) - 5);
  const child = await startBot(root, tg);
  try {
    await waitFor(() => tg.messages().some((message) => message.text.includes('ledger')), {
      label: 'fresh startup command answered'
    });
  } finally {
    killTree(child);
    await sleep(150);
    await tg.stop();
  }
});

test('an old command before a fresh one is skipped while the fresh one runs', async () => {
  const root = tempRoot('bot-mixed');
  seedWorkspace(root);
  const tg = await startFakeTelegram();
  tg.enqueue('/mute 60m', ADMIN, Math.floor(Date.now() / 1000) - 600);
  tg.enqueue('/ledger', ADMIN, Math.floor(Date.now() / 1000) - 2);
  const child = await startBot(root, tg);
  try {
    await waitFor(() => tg.messages().some((message) => message.text.includes('ledger')), {
      label: 'fresh command answered'
    });
    assert.ok(!tg.messages().some((message) => message.text.includes('muted')),
      'the stale /mute must not run');
    assert.throws(() => readFileSync(path.join(root, 'alert-control.json'), 'utf8'));
  } finally {
    killTree(child);
    await sleep(150);
    await tg.stop();
  }
});

test('a second bot instance refuses to run next to the first', async () => {
  const root = tempRoot('bot-dup');
  seedWorkspace(root);
  const tg = await startFakeTelegram();
  const env = baseEnv({ telegramUrl: tg.baseUrl, root, extra: { STATUS_BOT_PID: path.join(root, 'status-bot.pid') } });

  const first = spawnScript(path.join(ROOT, 'scripts/status-bot.mjs'), { cwd: root, env });
  await waitFor(() => first.output.stdout.includes('started PID'), { label: 'first bot' });

  const second = spawnScript(path.join(ROOT, 'scripts/status-bot.mjs'), { cwd: root, env });
  const code = await new Promise((resolve) => second.on('exit', resolve));
  assert.equal(code, 3);

  killTree(first);
  await sleep(200);
  await tg.stop();
});

test('the bot keeps running when the Telegram API errors', async () => {
  const root = tempRoot('bot-down');
  const env = baseEnv({ telegramUrl: 'http://127.0.0.1:1', root, extra: { STATUS_BOT_PID: path.join(root, 'status-bot.pid') } });
  const child = spawnScript(path.join(ROOT, 'scripts/status-bot.mjs'), { cwd: root, env });
  await sleep(1500);
  assert.equal(child.exitCode, null);
  assert.match(child.output.stderr, /getUpdates error/);
  killTree(child);
  await sleep(150);
});
