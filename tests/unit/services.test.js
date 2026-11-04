import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import {
  SERVICE_DEFS,
  SHARD_NAMES,
  SCRAPE_SERVICES,
  serviceDef,
  servicePaths,
  normalizeServiceName
} from '../../config/services.js';

test('the registry lists exactly the three scrapers', () => {
  assert.deepEqual(SHARD_NAMES, ['shard-1', 'melbet', 'linebet']);
  assert.deepEqual(SCRAPE_SERVICES, ['shard-1', 'melbet', 'linebet']);
  assert.deepEqual(Object.keys(SERVICE_DEFS).sort(), ['linebet', 'melbet', 'shard-1']);
});

test('the 1xbet shard owns the whole account list', () => {
  const shard = servicePaths('shard-1', 'C:\\ws');
  assert.equal(path.basename(shard.status), 'loop-status-shard-1.json');
  assert.equal(path.basename(shard.state), 'state-shard-1.json');
  assert.equal(path.basename(shard.screenshots), 'shard-1');
});

test('melbet resolves inside the sibling project and has no state file', () => {
  const melbet = servicePaths('melbet', 'C:\\ws\\1xauto');
  assert.equal(melbet.root, path.resolve('C:\\ws\\melbet-autologin'));
  assert.equal(melbet.state, null);
  assert.equal(melbet.summary, null);
  assert.equal(path.basename(melbet.status), 'loop-status.json');
  assert.equal(path.basename(melbet.screenshots), 'screenshots');
});

test('linebet resolves inside the sibling project and has no state file', () => {
  const linebet = servicePaths('linebet', 'C:\\ws\\1xauto');
  assert.equal(linebet.root, path.resolve('C:\\ws\\Linebet-autologin'));
  assert.equal(linebet.state, null);
  assert.equal(linebet.summary, null);
  assert.equal(path.basename(linebet.status), 'loop-status.json');
  assert.equal(path.basename(linebet.screenshots), 'screenshots');
});

test('unknown services resolve to null instead of throwing', () => {
  assert.equal(servicePaths('nope', 'C:\\ws'), null);
  assert.equal(serviceDef('nope'), null);
});

test('normalizeServiceName accepts the spellings an admin types', () => {
  assert.equal(normalizeServiceName('shard-1'), 'shard-1');
  assert.equal(normalizeServiceName('SHARD1'), 'shard-1');
  assert.equal(normalizeServiceName('melbet'), 'melbet');
  assert.equal(normalizeServiceName('melbet-scrape-2'), 'melbet');
  assert.equal(normalizeServiceName(' linebet '), 'linebet');
  assert.equal(normalizeServiceName('linebet-sender-1'), 'linebet');
  assert.equal(normalizeServiceName(''), 'unknown');
  assert.equal(normalizeServiceName(undefined), 'unknown');
  assert.equal(normalizeServiceName('other'), 'other');
});

test('every scraper start index is the first account of its own list', () => {
  assert.deepEqual(SERVICE_DEFS['shard-1'].range, [1, 276]);
  assert.equal(SERVICE_DEFS.melbet.range[0], 1);
  assert.equal(SERVICE_DEFS.linebet.range[0], 1);
});
