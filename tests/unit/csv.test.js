import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCsvLine, parseCsv, loadAccounts, getAccountsToProcess } from '../../lib/csv.js';

test('parseCsvLine handles quoted fields and escaped quotes', () => {
  assert.deepEqual(parseCsvLine('a,"b, c","d""e"'), ['a', 'b, c', 'd"e']);
});

test('parseCsvLine trims values', () => {
  assert.deepEqual(parseCsvLine('  user1 , pass1 '), ['user1', 'pass1']);
});

test('parseCsv maps headers to lowercase and skips empty lines', () => {
  const text = 'Username, Password\r\n  user1, pass1 \r\n\r\n';
  assert.deepEqual(parseCsv(text), [{ username: 'user1', password: 'pass1' }]);
});

test('parseCsv fills missing header cells with empty string', () => {
  const text = 'username,password,surname\nuser1,pass1';
  assert.deepEqual(parseCsv(text), [{ username: 'user1', password: 'pass1', surname: '' }]);
});

test('parseCsv returns empty array for empty text', () => {
  assert.deepEqual(parseCsv(''), []);
});

test('loadAccounts reads csv and filters rows missing username or password', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'csv-test-'));
  const file = path.join(dir, 'accounts.csv');
  writeFileSync(file, 'username,password,surname\nuser1,pass1,\nuser2,,s2\n,pass3,s3\n');
  try {
    const accounts = loadAccounts(file);
    assert.deepEqual(accounts, [{ username: 'user1', password: 'pass1', surname: '' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAccounts supports email-as-username fallback', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'csv-test-'));
  const file = path.join(dir, 'accounts.csv');
  writeFileSync(file, 'email,password\nuser@example.com,pass1\n');
  try {
    const accounts = loadAccounts(file);
    assert.deepEqual(accounts, [{ username: 'user@example.com', password: 'pass1', surname: '' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAccounts returns empty array when file is missing', () => {
  assert.deepEqual(loadAccounts(path.join('nope', 'accounts.csv')), []);
});

test('getAccountsToProcess uses csv when it has accounts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'csv-test-'));
  const file = path.join(dir, 'accounts.csv');
  writeFileSync(file, 'username,password\nuser1,pass1\n');
  try {
    assert.deepEqual(getAccountsToProcess(file), [{ username: 'user1', password: 'pass1', surname: '' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getAccountsToProcess falls back to env when csv has no accounts', () => {
  const prev = {
    u: process.env.ONEXBET_USERNAME,
    p: process.env.ONEXBET_PASSWORD,
    s: process.env.ONEXBET_SURNAME
  };
  process.env.ONEXBET_USERNAME = 'envuser';
  process.env.ONEXBET_PASSWORD = 'envpass';
  process.env.ONEXBET_SURNAME = 'envsurname';
  try {
    assert.deepEqual(getAccountsToProcess(path.join('nope', 'accounts.csv')), [
      { username: 'envuser', password: 'envpass', surname: 'envsurname' }
    ]);
  } finally {
    process.env.ONEXBET_USERNAME = prev.u;
    process.env.ONEXBET_PASSWORD = prev.p;
    process.env.ONEXBET_SURNAME = prev.s;
  }
});
