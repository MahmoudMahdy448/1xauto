// Process-level tests for scripts/realtime-send.mjs.
//
// The real sender watches a folder, claims numbers in the ledger and pushes
// photos to the admin chat and the channel. These tests point it at a temp
// folder and a fake Bot API, then assert on the photos, the ledger and the
// JSONL events it emits.
//
// The sender only sends screenshots written after it started and older than 2
// seconds (a half-written PNG must not be posted), so each test creates its
// screenshots *after* spawning the process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import path from 'path';
import { startFakeTelegram } from '../helpers/fake-telegram.mjs';
import { ROOT, baseEnv, killTree, sleep, spawnScript, tempRoot, waitFor } from '../helpers/process.mjs';

const ADMIN = '699397575';
const CHANNEL = '-1004357023695';

function shot(dir, name, { ageSeconds = 0 } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (ageSeconds > 0) {
    const when = new Date(Date.now() - ageSeconds * 1000);
    utimesSync(file, when, when);
  }
  return file;
}

function senderEvents(root) {
  const dir = path.join(root, 'events');
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.includes('-sender-'));
  } catch {
    return [];
  }
  return names.flatMap((name) =>
    readFileSync(path.join(dir, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
}

function ledger(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'seen-numbers.json'), 'utf8')).numbers || [];
  } catch {
    return [];
  }
}

async function runSender({ before, after, fake = {}, env = {} } = {}) {
  const root = tempRoot('sender');
  const shots = path.join(root, 'screenshots', 'shard-1');
  mkdirSync(shots, { recursive: true });
  const tg = await startFakeTelegram(fake);
  if (before) await before({ root, shots });
  if (fake.__ledger) {
    writeFileSync(
      path.join(root, 'seen-numbers.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), numbers: fake.__ledger })
    );
  }

  const child = spawnScript(path.join(ROOT, 'scripts/realtime-send.mjs'), {
    cwd: root,
    env: baseEnv({
      telegramUrl: tg.baseUrl,
      root,
      extra: {
        SCREENSHOTS_DIR: shots,
        SERVICE_NAME: 'shard-1',
        EVENT_ROLE: 'sender',
        REALTIME_POLL_MS: '250',
        ...env
      }
    })
  });

  // The sender only accepts files written after it started, so wait until it
  // has logged its watch line before creating screenshots. This is also what
  // happens in production: the process runs long before the first number.
  await waitFor(() => child.output.stdout.includes('Watching'), { label: 'sender watch line' });
  if (after) await after({ root, shots });

  return {
    root,
    shots,
    tg,
    child,
    events: () => senderEvents(root),
    ledger: () => ledger(root),
    async finish() {
      killTree(child);
      await sleep(150);
      await tg.stop();
    }
  };
}

test('a new stable screenshot goes to the admin chat and the channel', async () => {
  const run = await runSender({
    after: ({ shots }) => shot(shots, '01012345678.png')
  });
  try {
    await waitFor(() => run.tg.photos().length >= 2, { label: 'two photo sends' });
    const photos = run.tg.photos();
    assert.deepEqual(photos.map((photo) => photo.chatId).sort(), [CHANNEL, ADMIN].sort());
    assert.ok(photos.every((photo) => photo.caption === '01012345678'));
    assert.ok(photos.every((photo) => photo.fileName === '01012345678.png'));

    await waitFor(() => run.events().some((event) => event.kind === 'send.ok'), { label: 'send.ok event' });
    const ok = run.events().filter((event) => event.kind === 'send.ok');
    assert.equal(ok.length, 1);
    assert.equal(ok[0].data.number, '01012345678');
    assert.equal(ok[0].data.recipients, 2);
    assert.equal(ok[0].data.failed, 0);
    assert.equal(ok[0].svc, 'shard-1');
    assert.equal(ok[0].role, 'sender');
    assert.deepEqual(run.ledger(), ['01012345678']);
  } finally {
    await run.finish();
  }
});

test('screenshots from before the sender started are never sent', async () => {
  const run = await runSender({
    before: ({ shots }) => shot(shots, '01012345678.png', { ageSeconds: 120 }),
    after: ({ shots }) => shot(shots, '01099990000.png', { ageSeconds: 60 })
  });
  try {
    await sleep(2500);
    assert.deepEqual(run.tg.photos(), []);
    assert.deepEqual(run.events(), []);
    assert.deepEqual(run.ledger(), []);
  } finally {
    await run.finish();
  }
});

test('a number already in the ledger is skipped, not sent twice', async () => {
  const run = await runSender({
    before: ({ root }) => {
      writeFileSync(
        path.join(root, 'seen-numbers.json'),
        JSON.stringify({ updatedAt: new Date().toISOString(), numbers: ['01012345678'] })
      );
    },
    after: ({ shots }) => shot(shots, '01012345678.png')
  });
  try {
    await waitFor(() => run.events().some((event) => event.kind === 'send.skip'), { label: 'send.skip' });
    assert.deepEqual(run.tg.photos(), []);
    const skip = run.events().find((event) => event.kind === 'send.skip');
    assert.equal(skip.data.number, '01012345678');
    assert.equal(skip.data.reason, 'already-seen');
  } finally {
    await run.finish();
  }
});

test('a screenshot still being written is sent only after it stops changing', async () => {
  const run = await runSender({
    after: ({ shots }) => shot(shots, '01098765432.png')
  });
  try {
    // Younger than 2s: the first scans must leave it alone.
    await sleep(1000);
    assert.deepEqual(run.tg.photos(), [], 'posted a screenshot that may still be half-written');

    await waitFor(() => run.tg.photos().length >= 2, { label: 'delayed send', timeout: 10_000 });
    await waitFor(() => run.events().some((event) => event.kind === 'send.ok'), { label: 'send.ok event' });
  } finally {
    await run.finish();
  }
});

test('two files for the same number produce exactly one send', async () => {
  const run = await runSender({
    after: ({ shots }) => {
      shot(shots, '01012345678.png');
      shot(shots, '01012345678(2).png');
    }
  });
  try {
    await waitFor(() => run.tg.photos().length >= 2, { label: 'one number per scan' });
    await sleep(1500); // give a later scan a chance to double-send
    await waitFor(() => run.events().some((event) => event.kind === 'send.ok'), { label: 'send.ok event' });
    const ok = run.events().filter((event) => event.kind === 'send.ok');
    assert.equal(ok.length, 1, `sent the same number twice: ${JSON.stringify(ok)}`);
    assert.deepEqual(run.ledger(), ['01012345678']);
  } finally {
    await run.finish();
  }
});

test('a failing channel still counts as delivered and is reported', async () => {
  const run = await runSender({
    fake: { failPhotoChatIds: [CHANNEL] },
    after: ({ shots }) => shot(shots, '01012345678.png')
  });
  try {
    await waitFor(() => run.events().some((event) => event.kind === 'send.ok'), { label: 'send.ok' });
    const ok = run.events().find((event) => event.kind === 'send.ok');
    assert.equal(ok.data.recipients, 1);
    assert.equal(ok.data.failed, 1);

    const failed = run.events().filter((event) => event.kind === 'send.failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].data.error, new RegExp(CHANNEL));
    assert.deepEqual(run.ledger(), ['01012345678'], 'a delivered number must stay claimed');
  } finally {
    await run.finish();
  }
});

test('when no recipient accepts the photo the number is released for a retry', async () => {
  const run = await runSender({
    fake: { failPhotoChatIds: [ADMIN, CHANNEL] },
    after: ({ shots }) => shot(shots, '01012345678.png')
  });
  try {
    await waitFor(() => run.events().some((event) => event.kind === 'send.failed'), {
      label: 'send.failed',
      timeout: 10_000
    });
    const failed = run.events().find((event) => event.kind === 'send.failed');
    assert.match(failed.data.error, /simulated recipient failure/);
    assert.ok(!run.events().some((event) => event.kind === 'send.ok'));
    // The release happens right after the event is written.
    await waitFor(() => run.ledger().length === 0, { label: 'number released from the ledger' });
  } finally {
    await run.finish();
  }
});

test('retention deletes old already-sent screenshots and keeps unsent ones', async () => {
  const run = await runSender({
    fake: { __ledger: ['01011111111'] },
    env: { SCREENSHOT_RETENTION_MS: '1000' },
    after: ({ shots }) => {
      shot(shots, '01011111111.png', { ageSeconds: 10 }); // sent (in ledger), old
      shot(shots, '01022222222.png', { ageSeconds: 10 }); // never sent
    }
  });
  try {
    await waitFor(() => run.events().some((event) => event.kind === 'screenshot.pruned'), {
      label: 'screenshot.pruned event'
    });
    assert.ok(!existsSync(path.join(run.shots, '01011111111.png')), 'sent screenshot was not deleted');
    assert.ok(existsSync(path.join(run.shots, '01022222222.png')), 'unsent screenshot was deleted');
    const pruned = run.events().find((event) => event.kind === 'screenshot.pruned');
    assert.equal(pruned.data.count, 1);
    assert.equal(pruned.data.keptUnsent, 1);
  } finally {
    await run.finish();
  }
});

test('retention can be switched off', async () => {
  const run = await runSender({
    fake: { __ledger: ['01011111111'] },
    env: { SCREENSHOT_RETENTION: 'off' },
    after: ({ shots }) => shot(shots, '01011111111.png', { ageSeconds: 10 })
  });
  try {
    await sleep(2000);
    assert.ok(existsSync(path.join(run.shots, '01011111111.png')));
    assert.ok(!run.events().some((event) => event.kind === 'screenshot.pruned'));
  } finally {
    await run.finish();
  }
});

test('a missing token makes the sender exit quietly with code 0', async () => {
  const root = tempRoot('sender-noid');
  const tg = await startFakeTelegram();
  const child = spawnScript(path.join(ROOT, 'scripts/realtime-send.mjs'), {
    cwd: root,
    env: { ...baseEnv({ telegramUrl: tg.baseUrl, root }), TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' }
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(child.output.stdout, /not set — exiting/);
  await tg.stop();
});
