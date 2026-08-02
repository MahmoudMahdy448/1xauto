import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, formatSummary, FAILURE_CATEGORIES } from '../../lib/runSummary.js';

test('P5: buildSummary computes all §5.2 fields plus operational extras', () => {
  const summary = buildSummary({
    batchId: 'b-1',
    startedAt: '2026-08-02T02:00:00.000Z',
    endedAt: '2026-08-02T02:10:00.000Z',
    totalAccounts: 10,
    startIndex: 3,
    lastProcessedIndex: 10,
    proxyEnabled: true,
    maxRetries: 3,
    uniqueNumbers: 5,
    screenshots: ['01x.png', '01y.png'],
    results: [
      { username: 'a@x', outcome: 'success', retries: 0, runtimeMs: 30_000, category: null },
      { username: 'b@x', outcome: 'failure', retries: 2, runtimeMs: 90_000, category: 'network' },
      { username: 'c@x', outcome: 'failure', retries: 1, runtimeMs: 60_000, category: 'domTimeout' },
      { username: 'd@x', outcome: 'success', retries: 3, runtimeMs: 120_000, category: null }
    ]
  });

  assert.equal(summary.batchId, 'b-1');
  assert.equal(summary.durationMs, 600_000);
  assert.equal(summary.totalAccounts, 10);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 2);
  assert.equal(summary.accountsRetried, 3);
  assert.equal(summary.retryCount, 6);
  assert.equal(summary.successRate, 0.2);
  assert.equal(summary.uniqueNumbers, 5);
  assert.equal(summary.avgRuntimePerAccountMs, 150_000);
  assert.deepEqual(summary.slowestAccount, { username: 'd@x', runtimeMs: 120_000 });
  assert.equal(summary.screenshotsRetained, 2);
  assert.deepEqual(summary.artifactNames, ['01x.png', '01y.png']);
  assert.equal(summary.startIndex, 3);
  assert.equal(summary.lastProcessedIndex, 10);
  assert.equal(summary.proxyEnabled, true);
  assert.equal(summary.maxRetries, 3);
});

test('P5: buildSummary normalizes failureCategories with all categories zeroed', () => {
  const summary = buildSummary({
    results: [
      { username: 'a@x', outcome: 'failure', retries: 0, runtimeMs: 100, category: 'network' },
      { username: 'b@x', outcome: 'failure', retries: 0, runtimeMs: 100, category: 'other' }
    ]
  });

  for (const category of FAILURE_CATEGORIES) {
    assert.ok(category in summary.failureCategories, `missing category ${category}`);
  }
  assert.equal(summary.failureCategories.network, 1);
  assert.equal(summary.failureCategories.other, 1);
  assert.equal(summary.failureCategories.domTimeout, 0);
});

test('P5: buildSummary handles empty input with safe math', () => {
  const summary = buildSummary({});
  assert.equal(summary.totalAccounts, 0);
  assert.equal(summary.successRate, 0);
  assert.equal(summary.avgRuntimePerAccountMs, 0);
  assert.equal(summary.slowestAccount, null);
  assert.equal(summary.durationMs, 0);
  assert.deepEqual(summary.artifactNames, []);
});

test('P5: formatSummary renders the §5.3 human line', () => {
  const results = [];
  for (let i = 0; i < 70; i += 1) {
    results.push({ username: `ok${i}@x`, outcome: 'success', retries: 0, runtimeMs: 90_000, category: null });
  }
  for (let i = 0; i < 6; i += 1) {
    results.push({ username: `net${i}@x`, outcome: 'failure', retries: 0, runtimeMs: 1_000, category: 'network' });
  }
  for (let i = 0; i < 4; i += 1) {
    results.push({ username: `dom${i}@x`, outcome: 'failure', retries: 0, runtimeMs: 1_000, category: 'domTimeout' });
  }
  results[0].username = 'x@y';
  results[0].runtimeMs = 90_000;

  const summary = buildSummary({
    startedAt: '2026-08-02T02:00:00.000Z',
    endedAt: '2026-08-02T02:10:00.000Z',
    totalAccounts: 80,
    uniqueNumbers: 42,
    results
  });

  const line = formatSummary(summary);
  assert.equal(
    line,
    'Success rate: 87.5% (70/80) · unique numbers: 42 · slowest: x@y (90s) · network: 6, domTimeout: 4'
  );
});

test('P5: formatSummary omits slowest and categories when absent', () => {
  const summary = buildSummary({
    totalAccounts: 0,
    results: []
  });
  const line = formatSummary(summary);
  assert.equal(line, 'Success rate: 0% (0/0) · unique numbers: 0');
});
