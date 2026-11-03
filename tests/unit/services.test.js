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

test('the registry lists exactly the three scrapers plus sync', () => {
  assert.deepEqual(SHARD_NAMES, ['shard-1', 'shard-2', 'melbet']);
  assert.deepEqual(SCRAPE_SERVICES, ['shard-1', 'shard-2', 'melbet']);
  assert.deepEqual(Object.keys(SERVICE_DEFS).sort(), ['melbet', 'shard-1', 'shard-2', 'sync']);
});

test('each shard owns a distinct status, state and screenshot path', () => {
  const a = servicePaths('shard-1', 'C:\\ws');
  const b = servicePaths('shard-2', 'C:\\ws');
  assert.notEqual(a.status, b.status);
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.screenshots, b.screenshots);
  assert.equal(path.basename(a.status), 'loop-status-shard-1.json');
  assert.equal(path.basename(a.state), 'state-shard-1.json');
  assert.equal(path.basename(a.screenshots), 'shard-1');
});

test('melbet resolves inside the sibling project and has no state file', () => {
  const melbet = servicePaths('melbet', 'C:\\ws\\1xauto');
  assert.equal(melbet.root, path.resolve('C:\\ws\\melbet-autologin'));
  assert.equal(melbet.state, null);
  assert.equal(melbet.summary, null);
  assert.equal(path.basename(melbet.status), 'loop-status.json');
  assert.equal(path.basename(melbet.screenshots), 'screenshots');
});

test('sync has no paths to check', () => {
  const sync = servicePaths('sync', 'C:\\ws');
  assert.equal(sync.status, null);
  assert.equal(sync.screenshots, null);
  assert.equal(sync.range === undefined || sync.range === null, true);
});

test('unknown services resolve to null instead of throwing', () => {
  assert.equal(servicePaths('nope', 'C:\\ws'), null);
  assert.equal(serviceDef('nope'), null);
});

test('normalizeServiceName accepts the spellings an admin types', () => {
  assert.equal(normalizeServiceName('shard-1'), 'shard-1');
  assert.equal(normalizeServiceName('SHARD1'), 'shard-1');
  assert.equal(normalizeServiceName(' shard-2 '), 'shard-2');
  assert.equal(normalizeServiceName('melbet'), 'melbet');
  assert.equal(normalizeServiceName('melbet-scrape-2'), 'melbet');
  assert.equal(normalizeServiceName('telegram-sync'), 'sync');
  assert.equal(normalizeServiceName(''), 'unknown');
  assert.equal(normalizeServiceName(undefined), 'unknown');
  assert.equal(normalizeServiceName('other'), 'other');
});

test('the shard ranges do not overlap and cover the account file', () => {
  const [s1Start, s1End] = SERVICE_DEFS['shard-1'].range;
  const [s2Start, s2End] = SERVICE_DEFS['shard-2'].range;
  assert.equal(s1Start, 1);
  assert.equal(s2Start, s1End + 1);
  assert.equal(s2End, 276);
});
