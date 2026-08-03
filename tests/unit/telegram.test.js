import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTelegramMessage,
  dedupeScreenshotPaths,
  extractNumberFromScreenshotName
} from '../../lib/telegram.js';

test('buildTelegramMessage includes status, rates, numbers and duration', () => {
  const text = buildTelegramMessage({
    batchId: 'b1',
    totalAccounts: 100,
    startIndex: 1,
    lastProcessedIndex: 100,
    succeeded: 87,
    failed: 13,
    uniqueNumbers: 12,
    screenshotsRetained: 23,
    durationMs: 45000,
    retryCount: 0
  });

  assert.match(text, /b1 — ⚠️ partial failures/);
  assert.match(text, /Success rate: 87\.0% \(87\/100 processed\)/);
  assert.match(text, /Processed: 100\/100/);
  assert.match(text, /Unique numbers: 12/);
  assert.match(text, /Screenshots: 23/);
  assert.match(text, /Duration: 45s/);
  assert.ok(!/Retries/.test(text));
});

test('buildTelegramMessage computes rate against shard slice, not total accounts', () => {
  const text = buildTelegramMessage({
    batchId: 'shard-2',
    totalAccounts: 276,
    startIndex: 150,
    lastProcessedIndex: 276,
    succeeded: 126,
    failed: 1,
    uniqueNumbers: 99,
    screenshotsRetained: 126,
    durationMs: 60000
  });

  assert.match(text, /Success rate: 99\.2% \(126\/127 processed\)/);
  assert.match(text, /Processed: 276\/276/);
});

test('extractNumberFromScreenshotName finds the phone number', () => {
  assert.equal(extractNumberFromScreenshotName('account-01012345678.png'), '01012345678');
  assert.equal(extractNumberFromScreenshotName('01012345678(2).png'), '01012345678');
  assert.equal(extractNumberFromScreenshotName('no-number-here.png'), null);
});

test('dedupeScreenshotPaths keeps the first path per number', () => {
  const paths = ['a/01011111111.png', 'a/01022222222.png', 'a/01011111111(2).png'];
  assert.deepEqual(dedupeScreenshotPaths(paths), ['a/01011111111.png', 'a/01022222222.png']);
});
