import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTelegramMessage,
  buildTelegramUrl,
  sendTelegramMessage
} from '../../lib/telegram.js';

function sampleSummary(overrides = {}) {
  return {
    batchId: 'batch-42',
    startedAt: '2026-08-02T10:00:00.000Z',
    endedAt: '2026-08-02T10:05:00.000Z',
    durationMs: 300000,
    totalAccounts: 100,
    succeeded: 87,
    failed: 13,
    accountsRetried: 2,
    retryCount: 3,
    successRate: 0.87,
    uniqueNumbers: 5,
    avgRuntimePerAccountMs: 3000,
    slowestAccount: { username: 'slow@x', runtimeMs: 90000 },
    failureCategories: { network: 6, domTimeout: 4, loginRejected: 3, disk: 0, browserClosed: 0, validation: 0, other: 0 },
    screenshotsRetained: 87,
    artifactNames: [],
    startIndex: 1,
    lastProcessedIndex: 100,
    proxyEnabled: false,
    maxRetries: 2,
    ...overrides
  };
}

test('buildTelegramMessage includes status, rates, numbers and duration', () => {
  const text = buildTelegramMessage(sampleSummary());
  assert.ok(text.includes('Batch batch-42 — ⚠️ partial failures'));
  assert.ok(text.includes('Success rate: 87.0% (87/100)'));
  assert.ok(text.includes('Processed: 100/100'));
  assert.ok(text.includes('Unique numbers: 5'));
  assert.ok(text.includes('Screenshots: 87'));
  assert.ok(text.includes('Duration: 300s'));
  assert.ok(text.includes('Retries: 3'));
});

test('buildTelegramMessage marks OK when no failures and omits retries line', () => {
  const text = buildTelegramMessage(sampleSummary({ failed: 0, retryCount: 0 }));
  assert.ok(text.includes('— OK'));
  assert.ok(!text.includes('Retries:'));
});

test('buildTelegramMessage handles null batchId', () => {
  const text = buildTelegramMessage(sampleSummary({ batchId: null }));
  assert.ok(text.includes('Batch n/a —'));
});

test('buildTelegramUrl assembles the sendMessage endpoint', () => {
  assert.equal(
    buildTelegramUrl('123:ABC'),
    'https://api.telegram.org/bot123:ABC/sendMessage'
  );
});

test('sendTelegramMessage posts JSON and throws on non-OK response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.telegram.org/bot123:ABC/sendMessage');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).chat_id, '999');
    assert.equal(JSON.parse(options.body).text, 'hello');
    return { ok: false, status: 400, text: async () => 'bad request' };
  };

  await assert.rejects(
    () => sendTelegramMessage({ botToken: '123:ABC', chatId: '999', text: 'hello' }),
    /Telegram API error 400: bad request/
  );

  globalThis.fetch = originalFetch;
});
