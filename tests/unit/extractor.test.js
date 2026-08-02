import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { extractPhoneNumber, buildScreenshotPath, fallbackScreenshotPath } from '../../lib/extractor.js';

test('extractPhoneNumber returns first 01xxxxxxxxx match', () => {
  assert.equal(extractPhoneNumber('copy 01234567890 now'), '01234567890');
});

test('extractPhoneNumber returns empty string when no match', () => {
  assert.equal(extractPhoneNumber('no number here'), '');
  assert.equal(extractPhoneNumber(null), '');
  assert.equal(extractPhoneNumber(''), '');
});

test('buildScreenshotPath first occurrence uses plain filename', () => {
  assert.equal(
    buildScreenshotPath('01234567890', 1, () => false),
    path.join('screenshots', '01234567890.png')
  );
});

test('buildScreenshotPath duplicate uses (n) suffix', () => {
  assert.equal(
    buildScreenshotPath('01234567890', 2, () => false),
    path.join('screenshots', '01234567890(2).png')
  );
});

test('buildScreenshotPath skips existing files', () => {
  const existing = (p) =>
    p === path.join('screenshots', '01234567890.png') ||
    p === path.join('screenshots', '01234567890(2).png');
  assert.equal(
    buildScreenshotPath('01234567890', 1, existing),
    path.join('screenshots', '01234567890(3).png')
  );
});

test('fallbackScreenshotPath builds timestamped path', () => {
  assert.equal(
    fallbackScreenshotPath('2026-08-02T00-00-00-000Z'),
    path.join('screenshots', 'vodafone-deposit-2026-08-02T00-00-00-000Z.png')
  );
});
