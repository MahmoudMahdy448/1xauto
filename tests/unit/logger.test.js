import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdirSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { formatLogLine, createLogger } from '../../lib/logger.js';

let dirSeq = 0;

function tempDir() {
  const dir = path.join(tmpdir(), `1xauto-logger-test-${process.pid}-${dirSeq++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('formatLogLine includes ISO timestamp, padded level, fields and message', () => {
  const line = formatLogLine({
    level: 'info',
    message: 'submitting credentials',
    fields: { account: 'asyut1@x', phase: 'login' },
    ts: new Date('2026-08-02T02:00:01.000Z')
  });
  assert.equal(
    line,
    '[2026-08-02T02:00:01.000Z] [info]  [account=asyut1@x] [phase=login] submitting credentials'
  );
});

test('formatLogLine pads [info] and [warn] to align with [error]', () => {
  const info = formatLogLine({ level: 'info', message: 'm' });
  const warn = formatLogLine({ level: 'warn', message: 'm' });
  const error = formatLogLine({ level: 'error', message: 'm' });
  assert.match(info, /\[info\]\s{2}/);
  assert.match(warn, /\[warn\]\s{2}/);
  assert.match(error, /\[error\]\s{1}/);
});

test('formatLogLine omits undefined and null fields', () => {
  const line = formatLogLine({
    level: 'warn',
    message: 'retry soon',
    fields: { account: 'a@x', phase: null, index: undefined }
  });
  assert.ok(line.includes('[account=a@x]'));
  assert.ok(!line.includes('[phase='));
  assert.ok(!line.includes('[index='));
});

test('createLogger writes info to the stream and persists to logFile', () => {
  const dir = tempDir();
  const logFile = path.join(dir, 'run.log');
  const lines = [];
  const stream = { write: (chunk) => lines.push(chunk) };
  const errorStream = { write: (chunk) => lines.push(chunk) };
  const logger = createLogger({ stream, errorStream, logFile });

  logger.info('started', { phase: 'batch' });
  logger.error('boom', { phase: 'payment' });

  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[info\]/);
  assert.match(lines[1], /\[error\]/);

  const fileContent = readFileSync(logFile, 'utf8');
  assert.match(fileContent, /started/);
  assert.match(fileContent, /boom/);
});
