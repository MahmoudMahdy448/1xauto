import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, isRetryable, backoffDelay } from '../../lib/retry.js';

test('P2 stubs: classifyError defaults to non-retryable other', () => {
  assert.deepEqual(classifyError(new Error('boom')), { retryable: false, category: 'other' });
});

test('P2 stubs: isRetryable returns false', () => {
  assert.equal(isRetryable(), false);
});

test('P2 stubs: backoffDelay returns default 2000ms', () => {
  assert.equal(backoffDelay(), 2000);
});
