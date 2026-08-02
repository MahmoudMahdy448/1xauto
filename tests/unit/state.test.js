import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { readState, writeState, resolveStartIndex, resolveEndIndex } from '../../lib/state.js';

let dirSeq = 0;

function tempStateFile(name) {
  const dir = path.join(tmpdir(), `1xauto-state-test-${process.pid}-${dirSeq++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

test('readState returns null when file does not exist', () => {
  assert.equal(readState(tempStateFile('missing.json')), null);
  assert.equal(readState(undefined), null);
});

test('readState returns null on invalid JSON', () => {
  const file = tempStateFile('invalid.json');
  writeFileSync(file, '{ not json');
  assert.equal(readState(file), null);
});

test('readState parses valid state object', () => {
  const file = tempStateFile('valid.json');
  writeFileSync(file, JSON.stringify({ lastProcessedIndex: 3, totalAccounts: 500 }));
  assert.deepEqual(readState(file), { lastProcessedIndex: 3, totalAccounts: 500 });
});

test('writeState writes the state atomically and leaves no .tmp behind', () => {
  const file = tempStateFile('state.json');
  writeState({ lastProcessedIndex: 3, totalAccounts: 500 }, file);
  assert.deepEqual(readState(file), { lastProcessedIndex: 3, totalAccounts: 500 });
  assert.equal(existsSync(`${file}.tmp`), false);
});

test('writeState overwrites existing state', () => {
  const file = tempStateFile('state.json');
  writeState({ lastProcessedIndex: 1 }, file);
  writeState({ lastProcessedIndex: 2 }, file);
  assert.deepEqual(readState(file), { lastProcessedIndex: 2 });
});

test('writeState output is pretty-printed JSON', () => {
  const file = tempStateFile('state.json');
  writeState({ lastProcessedIndex: 3 }, file);
  const raw = readFileSync(file, 'utf8');
  assert.ok(raw.includes('\n  "lastProcessedIndex": 3'));
});

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

test('resolveEndIndex defaults to total accounts', () => {
  assert.equal(resolveEndIndex(undefined, 276), 276);
  assert.equal(resolveEndIndex(null, 276), 276);
});

test('resolveEndIndex clamps to total accounts', () => {
  assert.equal(resolveEndIndex(300, 276), 276);
});

test('resolveEndIndex returns explicit end', () => {
  assert.equal(resolveEndIndex(92, 276), 92);
});

test('resolveEndIndex throws on invalid values', () => {
  assert.throws(() => resolveEndIndex(0, 276), /Invalid END_INDEX/);
  assert.throws(() => resolveEndIndex(-5, 276), /Invalid END_INDEX/);
});
