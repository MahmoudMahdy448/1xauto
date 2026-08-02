import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readState, writeState, resolveStartIndex } from '../../lib/state.js';

test('resolveStartIndex explicit start wins over state', () => {
  assert.equal(resolveStartIndex({ lastProcessedIndex: 3 }, 7), 7);
});

test('resolveStartIndex resumes at state lastProcessedIndex + 1', () => {
  assert.equal(resolveStartIndex({ lastProcessedIndex: 3 }, undefined), 4);
});

test('resolveStartIndex defaults to 1', () => {
  assert.equal(resolveStartIndex(null, undefined), 1);
  assert.equal(resolveStartIndex({}, undefined), 1);
});

test('P2 stubs: readState returns null, writeState is a no-op', () => {
  assert.equal(readState(), null);
  assert.doesNotThrow(() => writeState({}));
});
