import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary } from '../../lib/runSummary.js';

test('P2 stub: buildSummary returns default counters', () => {
  assert.deepEqual(buildSummary(), {
    totalAccounts: 0,
    succeeded: 0,
    failed: 0,
    successRate: 0
  });
});
