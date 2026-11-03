import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeStartIndex } from '../../lib/resume.js';

test('no saved state means the shard starts at its own range start', () => {
  assert.equal(resumeStartIndex(null, 150), 150);
  assert.equal(resumeStartIndex(undefined, '1'), 1);
});

test('a saved state continues after the last completed account', () => {
  assert.equal(resumeStartIndex({ lastProcessedIndex: 89 }, 1), 90);
  assert.equal(resumeStartIndex({ lastProcessedIndex: 265 }, 150), 266);
});

test('a state older than the range start never moves the start backwards', () => {
  assert.equal(resumeStartIndex({ lastProcessedIndex: 3 }, 150), 150);
  assert.equal(resumeStartIndex({ lastProcessedIndex: 0 }, 1), 1);
});

test('a finished pass restarts at the range start, not one past the end', () => {
  // Resuming at 150 with END=149 is an empty pass, and the loop then cools
  // down for 90 minutes having done nothing. A completed range starts over.
  assert.equal(resumeStartIndex({ lastProcessedIndex: 149 }, 1, '149'), 1);
  assert.equal(resumeStartIndex({ lastProcessedIndex: 276 }, 150, '276'), 150);
});

test('a range without an end (melbet) still resumes past the last account', () => {
  assert.equal(resumeStartIndex({ lastProcessedIndex: 40 }, 1, ''), 41);
  assert.equal(resumeStartIndex({ lastProcessedIndex: 149 }, 1), 150);
});

test('a mid-range resume stays inside the range', () => {
  assert.equal(resumeStartIndex({ lastProcessedIndex: 60 }, 1, '149'), 61);
  assert.equal(resumeStartIndex({ lastProcessedIndex: 200 }, 150, '276'), 201);
});

test('junk in the state file falls back to the range start', () => {
  assert.equal(resumeStartIndex({ lastProcessedIndex: 'nope' }, 1), 1);
  assert.equal(resumeStartIndex({ lastProcessedIndex: null }, 1), 1);
  assert.equal(resumeStartIndex({ lastProcessedIndex: NaN }, 1), 1);
  assert.equal(resumeStartIndex({}, 1), 1);
});

test('the base start is parsed leniently', () => {
  assert.equal(resumeStartIndex({ lastProcessedIndex: 10 }, '150'), 150);
  assert.equal(resumeStartIndex({ lastProcessedIndex: 10 }, 'abc'), 11);
});
