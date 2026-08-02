import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProxyUrl } from '../../lib/proxy.js';

test('P2 stub: parseProxyUrl returns null when unset or empty', () => {
  assert.equal(parseProxyUrl(''), null);
  assert.equal(parseProxyUrl(undefined), null);
});

test('P2 stub: parseProxyUrl returns server url', () => {
  assert.deepEqual(parseProxyUrl('http://host:8080'), { server: 'http://host:8080' });
});
