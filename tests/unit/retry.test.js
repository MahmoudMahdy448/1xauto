import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyError,
  isRetryable,
  readMaxRetries,
  backoffDelay,
  runWithRetry
} from '../../lib/retry.js';

const noDelay = () => 0;

test('classifyError: network errors are retryable', () => {
  for (const message of [
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_CONNECTION_TIMED_OUT',
    'ECONNREFUSED',
    'connect ETIMEDOUT',
    'ERR_NAME_NOT_RESOLVED'
  ]) {
    assert.deepEqual(classifyError(new Error(message)), {
      retryable: true,
      category: 'network'
    });
  }
});

test('classifyError: browser closed is retryable', () => {
  assert.deepEqual(classifyError(new Error('Target page, context or browser has been closed')), {
    retryable: true,
    category: 'browserClosed'
  });
});

test('classifyError: disk full is retryable', () => {
  assert.deepEqual(classifyError(new Error('ENOSPC: no space left on device')), {
    retryable: true,
    category: 'disk'
  });
});

test('classifyError: dom timeout is retryable', () => {
  assert.deepEqual(classifyError(new Error('locator.toBeVisible: Timeout 30000ms exceeded')), {
    retryable: true,
    category: 'domTimeout'
  });
});

test('classifyError: login rejected is not retryable', () => {
  assert.deepEqual(classifyError(new Error('Login failed: invalid credentials')), {
    retryable: false,
    category: 'loginRejected'
  });
});

test('classifyError: validation errors are not retryable', () => {
  assert.deepEqual(
    classifyError(new Error('ONEXBET_PASSWORD and ONEXBET_SURNAME must contain different values.')),
    { retryable: false, category: 'validation' }
  );
  assert.deepEqual(
    classifyError(new Error('Set ONEXBET_USERNAME and ONEXBET_PASSWORD in your environment or .env file, or add rows to accounts.csv.')),
    { retryable: false, category: 'validation' }
  );
});

test('classifyError: unknown errors fall back to non-retryable other', () => {
  assert.deepEqual(classifyError(new Error('boom')), {
    retryable: false,
    category: 'other'
  });
});

test('isRetryable mirrors classifyError', () => {
  assert.equal(isRetryable(new Error('net::ERR_CONNECTION_CLOSED')), true);
  assert.equal(isRetryable(new Error('Login failed: nope')), false);
});

test('readMaxRetries defaults to 2 and validates env', () => {
  assert.equal(readMaxRetries({}), 2);
  assert.equal(readMaxRetries({ MAX_RETRIES: '' }), 2);
  assert.equal(readMaxRetries({ MAX_RETRIES: '3' }), 3);
  assert.throws(() => readMaxRetries({ MAX_RETRIES: 'abc' }), /Invalid MAX_RETRIES/);
  assert.throws(() => readMaxRetries({ MAX_RETRIES: '0' }), /Invalid MAX_RETRIES/);
  assert.throws(() => readMaxRetries({ MAX_RETRIES: '-1' }), /Invalid MAX_RETRIES/);
});

test('backoffDelay: exponential backoff with jitter', () => {
  const fixedRandom = () => 0;
  assert.equal(backoffDelay(0, { random: fixedRandom }), 2000);
  assert.equal(backoffDelay(1, { random: fixedRandom }), 4000);
  assert.equal(backoffDelay(2, { random: fixedRandom }), 8000);
  assert.equal(backoffDelay(3, { random: fixedRandom }), 15000);
  assert.equal(backoffDelay(10, { random: fixedRandom }), 15000);
});

test('backoffDelay: jitter is within [0, 1000)', () => {
  const random = () => 0.999999;
  const delay = backoffDelay(0, { random });
  assert.ok(delay >= 2000 && delay < 3000);
});

test('runWithRetry: succeeds on the second attempt', async () => {
  let calls = 0;
  const result = await runWithRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('net::ERR_CONNECTION_CLOSED');
      }
      return 'ok';
    },
    { maxRetries: 2, delayFn: noDelay }
  );

  assert.equal(result.outcome, 'success');
  assert.equal(result.retries, 1);
  assert.equal(result.value, 'ok');
  assert.equal(calls, 2);
});

test('runWithRetry: exhausts max retries', async () => {
  let calls = 0;
  const retryLog = [];
  const result = await runWithRetry(
    async () => {
      calls += 1;
      throw new Error('net::ERR_CONNECTION_CLOSED');
    },
    {
      maxRetries: 3,
      delayFn: noDelay,
      onRetry: (info) => retryLog.push(info.category)
    }
  );

  assert.equal(result.outcome, 'failure');
  assert.equal(result.retries, 2);
  assert.equal(result.category, 'network');
  assert.match(result.error.message, /net::ERR_CONNECTION_CLOSED/);
  assert.equal(calls, 3);
  assert.deepEqual(retryLog, ['network', 'network']);
});

test('runWithRetry: does not retry non-retryable errors', async () => {
  let calls = 0;
  const result = await runWithRetry(
    async () => {
      calls += 1;
      throw new Error('Login failed: bad password');
    },
    { maxRetries: 2, delayFn: noDelay }
  );

  assert.equal(result.outcome, 'failure');
  assert.equal(result.retries, 0);
  assert.equal(result.category, 'loginRejected');
  assert.equal(calls, 1);
});

test('runWithRetry: passes attempt-scaled delay to backoffDelay', async () => {
  const seenDelays = [];
  let calls = 0;
  const result = await runWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('net::ERR_CONNECTION_CLOSED');
      }
      return 'ok';
    },
    {
      maxRetries: 3,
      delayFn: (attempt) => {
        seenDelays.push(attempt);
        return 0;
      }
    }
  );

  assert.equal(result.outcome, 'success');
  assert.deepEqual(seenDelays, [0, 1]);
});
