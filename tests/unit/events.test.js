import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import {
  buildEvent,
  dayKey,
  emit,
  eventsFilePath,
  listEventFiles,
  parseEventLines,
  readFrom,
  readTail
} from '../../lib/events.js';

let dirSeq = 0;

function tempDir(name = 'events') {
  const dir = path.join(tmpdir(), `1xauto-events-test-${process.pid}-${dirSeq++}`);
  const target = path.join(dir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  return target;
}

function withEventsDir(dir, fn) {
  const previous = process.env.EVENTS_DIR;
  process.env.EVENTS_DIR = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.EVENTS_DIR;
    else process.env.EVENTS_DIR = previous;
  }
}

test('buildEvent fills the schema defaults', () => {
  const event = buildEvent(
    { kind: 'step', step: 'login.fill', account: 'a@b.c', data: { ok: true } },
    { svc: 'shard-1', role: 'scrape', inst: '2' }
  );

  assert.equal(event.svc, 'shard-1');
  assert.equal(event.role, 'scrape');
  assert.equal(event.inst, '2');
  assert.equal(event.kind, 'step');
  assert.equal(event.step, 'login.fill');
  assert.equal(event.account, 'a@b.c');
  assert.deepEqual(event.data, { ok: true });
  assert.equal(typeof event.pid, 'number');
  assert.ok(!Number.isNaN(Date.parse(event.ts)));
});

test('buildEvent drops null data and truncates very long strings', () => {
  const long = 'x'.repeat(1000);
  const event = buildEvent({ kind: 'step', data: { a: null, b: undefined, c: long } });
  assert.deepEqual(Object.keys(event.data), ['c']);
  assert.ok(event.data.c.endsWith('…'));
  assert.ok(event.data.c.length < 1000);
});

test('file names include service, role, instance and day', () => {
  const date = new Date('2026-10-29T16:12:03.221Z');
  const file = eventsFilePath({ svc: 'shard-2', role: 'sender', inst: '1', date, root: 'C:\\ws' });
  assert.equal(path.basename(file), 'shard-2-sender-1-2026-10-29.jsonl');
  assert.equal(dayKey(date), '2026-10-29');
});

test('two roles in the same service never share a file', () => {
  const date = new Date('2026-10-29T10:00:00.000Z');
  const scrape = eventsFilePath({ svc: 'shard-1', role: 'scrape', inst: '1', date, root: 'C:\\ws' });
  const sender = eventsFilePath({ svc: 'shard-1', role: 'sender', inst: '1', date, root: 'C:\\ws' });
  assert.notEqual(path.basename(scrape), path.basename(sender));
});

test('emit appends one JSON line per event into the right file', () => {
  const dir = tempDir();
  withEventsDir(dir, () => {
    emit({ svc: 'shard-1', role: 'scrape', inst: '1', kind: 'step', step: 'page.open' });
    emit({ svc: 'shard-1', role: 'scrape', inst: '1', kind: 'step', step: 'login.fill' });
  });

  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const lines = readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).step, 'page.open');
  assert.equal(JSON.parse(lines[1]).step, 'login.fill');
});

test('emit separates concurrent roles into different files', () => {
  const dir = tempDir();
  withEventsDir(dir, () => {
    emit({ svc: 'shard-1', role: 'scrape', kind: 'step', step: 'a' });
    emit({ svc: 'shard-1', role: 'sender', kind: 'send.ok', data: { number: '01012345678' } });
  });

  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 2);
  assert.ok(files.some((name) => name.includes('-scrape-')));
  assert.ok(files.some((name) => name.includes('-sender-')));
});

test('emit takes svc, role and instance from the environment when not passed', () => {
  const dir = tempDir();
  const previous = {
    SERVICE_NAME: process.env.SERVICE_NAME,
    EVENT_ROLE: process.env.EVENT_ROLE,
    INSTANCE_ID: process.env.INSTANCE_ID
  };
  process.env.SERVICE_NAME = 'shard-2';
  process.env.EVENT_ROLE = 'scrape';
  process.env.INSTANCE_ID = '1';
  try {
    withEventsDir(dir, () => {
      emit({ kind: 'step', step: 'a' });
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  assert.deepEqual(files, [`shard-2-scrape-1-${dayKey()}.jsonl`]);
  const event = JSON.parse(readFileSync(path.join(dir, files[0]), 'utf8').trim());
  assert.equal(event.svc, 'shard-2');
  assert.equal(event.role, 'scrape');
});

test('emit never throws when the events directory cannot be created', () => {
  const base = tempDir();
  const notADir = path.join(base, 'not-a-dir');
  writeFileSync(notADir, 'file, not a directory');
  const bad = path.join(notADir, 'events');
  withEventsDir(bad, () => {
    assert.doesNotThrow(() => emit({ svc: 'shard-1', kind: 'step', step: 'x' }));
  });
});

test('parseEventLines skips malformed lines but keeps good ones', () => {
  const text = [
    JSON.stringify({ ts: '2026-10-29T10:00:00.000Z', kind: 'step' }),
    '{ broken json',
    'null',
    '[1,2,3]',
    '',
    JSON.stringify({ ts: '2026-10-29T10:00:01.000Z', kind: 'step' })
  ].join('\n');

  const { events, malformed } = parseEventLines(text);
  assert.equal(events.length, 2);
  assert.equal(malformed.length, 3);
});

test('readFrom and readTail only read the requested slice', () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.jsonl');
  const first = `${JSON.stringify({ ts: '2026-10-29T10:00:00.000Z', kind: 'a' })}\n`;
  const second = `${JSON.stringify({ ts: '2026-10-29T10:00:01.000Z', kind: 'b' })}\n`;
  writeFileSync(file, first + second);

  const from = readFrom(file, Buffer.byteLength(first));
  assert.equal(from.text, second);
  assert.equal(from.offset, Buffer.byteLength(first + second));

  const tail = readTail(file, 10);
  assert.ok(tail.length > 0);
  assert.ok(tail.endsWith('\n'));
});

test('listEventFiles returns only event files, newest last', async () => {
  const dir = tempDir();
  withEventsDir(dir, () => {
    emit({ svc: 'shard-1', role: 'scrape', kind: 'step' });
  });
  writeFileSync(path.join(dir, 'ignore.txt'), 'not an event');

  const files = listEventFiles(path.dirname(dir));
  assert.equal(files.length, 1);
  assert.ok(files[0].name.endsWith('.jsonl'));
  assert.ok(files[0].size > 0);
});

test('a day rollover produces a new file', () => {
  const day1 = eventsFilePath({ svc: 'shard-1', role: 'scrape', inst: '1', date: new Date('2026-10-28T23:59:00Z'), root: 'C:\\ws' });
  const day2 = eventsFilePath({ svc: 'shard-1', role: 'scrape', inst: '1', date: new Date('2026-10-29T00:01:00Z'), root: 'C:\\ws' });
  assert.notEqual(path.basename(day1), path.basename(day2));
  assert.ok(day1.endsWith('2026-10-28.jsonl'));
  assert.ok(day2.endsWith('2026-10-29.jsonl'));
});
