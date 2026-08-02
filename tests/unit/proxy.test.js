import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProxyUrl, maskProxyPassword } from '../../lib/proxy.js';

test('parseProxyUrl returns null when unset or empty', () => {
  assert.equal(parseProxyUrl(''), null);
  assert.equal(parseProxyUrl(undefined), null);
  assert.equal(parseProxyUrl(null), null);
});

test('parseProxyUrl returns server only for credential-less url', () => {
  assert.deepEqual(parseProxyUrl('http://host:8080'), { server: 'http://host:8080' });
});

test('parseProxyUrl splits username and password', () => {
  assert.deepEqual(parseProxyUrl('http://user:pass@host:8080'), {
    server: 'http://host:8080',
    username: 'user',
    password: 'pass'
  });
});

test('parseProxyUrl decodes percent-encoded credentials', () => {
  assert.deepEqual(parseProxyUrl('http://user%40x:p%40ss@host:8080'), {
    server: 'http://host:8080',
    username: 'user@x',
    password: 'p@ss'
  });
});

test('parseProxyUrl throws on malformed url', () => {
  assert.throws(() => parseProxyUrl('not a url'), /Invalid PROXY_URL/);
  assert.throws(() => parseProxyUrl('ftp://host:8080'), /protocol/);
  assert.throws(() => parseProxyUrl('http://'), /Invalid PROXY_URL/);
});

test('maskProxyPassword leaves credential-less url untouched', () => {
  assert.equal(maskProxyPassword('http://host:8080'), 'http://host:8080');
});

test('maskProxyPassword redacts the password only', () => {
  assert.equal(maskProxyPassword('http://user:secret@host:8080'), 'http://user:***@host:8080');
});

test('maskProxyPassword handles missing values', () => {
  assert.equal(maskProxyPassword(undefined), undefined);
  assert.equal(maskProxyPassword(''), '');
});
