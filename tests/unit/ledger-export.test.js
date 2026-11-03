// Unit tests for lib/ledger-export.js — the CSV the /csv command sends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { buildLedgerCsv, fileStamp, readLedger, writeLedgerCsv } from '../../lib/ledger-export.js';

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'ledger-export-'));
}

test('buildLedgerCsv writes a header, sorts and dedupes', () => {
  const csv = buildLedgerCsv(['01033334444', '01011112222', '01033334444']);
  assert.equal(csv, 'number\r\n01011112222\r\n01033334444\r\n');
});

test('buildLedgerCsv on an empty ledger is just the header', () => {
  assert.equal(buildLedgerCsv([]), 'number\r\n');
});

test('readLedger tolerates a missing or corrupt file', () => {
  const dir = tmp();
  assert.deepEqual(readLedger(path.join(dir, 'missing.json')), { numbers: [], updatedAt: null });

  const corrupt = path.join(dir, 'corrupt.json');
  writeFileSync(corrupt, '{not json', 'utf8');
  assert.deepEqual(readLedger(corrupt), { numbers: [], updatedAt: null });
});

test('writeLedgerCsv copies the ledger into exports/ without touching it', () => {
  const dir = tmp();
  const ledgerPath = path.join(dir, 'seen-numbers.json');
  const ledger = { updatedAt: '2026-10-29T20:38:44.429Z', numbers: ['01022223333', '01011112222'] };
  writeFileSync(ledgerPath, JSON.stringify(ledger), 'utf8');

  const out = writeLedgerCsv({ ledgerPath, outDir: path.join(dir, 'exports'), now: new Date(2026, 9, 29, 23, 38) });

  assert.equal(out.count, 2);
  assert.equal(out.name, 'ledger-2026-10-29-2338.csv');
  assert.equal(out.updatedAt, ledger.updatedAt);
  assert.equal(readFileSync(out.file, 'utf8'), 'number\r\n01011112222\r\n01022223333\r\n');
  assert.deepEqual(JSON.parse(readFileSync(ledgerPath, 'utf8')), ledger, 'the ledger is read-only input');
});

test('fileStamp is local time and filesystem safe', () => {
  assert.equal(fileStamp(new Date(2026, 0, 5, 4, 7)), '2026-01-05-0407');
});
