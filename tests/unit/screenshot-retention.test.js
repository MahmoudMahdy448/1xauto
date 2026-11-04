import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SCREENSHOT_RETENTION_MS,
  pruneSentScreenshots,
  screenshotRetentionMs
} from '../../lib/screenshot-retention.js';

const MINUTE = 60 * 1000;

function makeDir() {
  return mkdtempSync(path.join(os.tmpdir(), '1xauto-retention-'));
}

function shot(dir, name, { ageMs = 0, bytes = 8 } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.alloc(bytes, 0x89));
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(file, when, when);
  }
  return file;
}

function ledger(dir, numbers) {
  const file = path.join(dir, 'seen-numbers.json');
  writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), numbers }));
  return file;
}

test('deletes only old screenshots whose number is already in the ledger', () => {
  const dir = makeDir();
  try {
    const shots = path.join(dir, 'screenshots');
    const seen = ledger(dir, ['01011111111']);
    for (const name of ['01011111111.png', '01022222222.png', '01033333333.png', 'no-number.png', 'notes.txt']) {
      shot(shots, name, { ageMs: 2 * MINUTE });
    }

    const result = pruneSentScreenshots({ screenshotsDir: shots, seenNumbersFile: seen, retentionMs: MINUTE });

    assert.deepEqual(readdirSync(shots).sort(), [
      '01022222222.png', // old but never sent -> keep for (re)delivery
      '01033333333.png', // old but never sent -> keep for (re)delivery
      'no-number.png',   // no number -> delivery cannot be verified -> keep
      'notes.txt'        // not an image -> ignore
    ].sort());
    assert.deepEqual(result.deleted, ['01011111111.png']);
    assert.equal(result.keptUnsent, 2);
    assert.equal(result.keptNoNumber, 1);
    assert.ok(result.freedBytes > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps a sent screenshot that is younger than the retention window', () => {
  const dir = makeDir();
  try {
    const shots = path.join(dir, 'screenshots');
    const seen = ledger(dir, ['01011111111']);
    shot(shots, '01011111111.png', { ageMs: 10 * 1000 });

    const result = pruneSentScreenshots({ screenshotsDir: shots, seenNumbersFile: seen, retentionMs: MINUTE });

    assert.equal(result.deleted.length, 0);
    assert.equal(result.keptYoung, 1);
    assert.ok(existsSync(path.join(shots, '01011111111.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deletes every duplicate file of an already-sent number', () => {
  const dir = makeDir();
  try {
    const shots = path.join(dir, 'screenshots');
    const seen = ledger(dir, ['01011111111']);
    shot(shots, '01011111111.png', { ageMs: 2 * MINUTE });
    shot(shots, '01011111111(2).png', { ageMs: 2 * MINUTE });

    const result = pruneSentScreenshots({ screenshotsDir: shots, seenNumbersFile: seen, retentionMs: MINUTE });

    assert.deepEqual(result.deleted.sort(), ['01011111111(2).png', '01011111111.png']);
    assert.deepEqual(readdirSync(shots), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps everything when the ledger is missing or empty', () => {
  const dir = makeDir();
  try {
    const shots = path.join(dir, 'screenshots');
    shot(shots, '01011111111.png', { ageMs: 2 * MINUTE });

    const missing = pruneSentScreenshots({
      screenshotsDir: shots,
      seenNumbersFile: path.join(dir, 'missing.json'),
      retentionMs: MINUTE
    });
    assert.equal(missing.deleted.length, 0);
    assert.equal(missing.keptUnsent, 1);

    const empty = pruneSentScreenshots({
      screenshotsDir: shots,
      seenNumbersFile: ledger(dir, []),
      retentionMs: MINUTE
    });
    assert.equal(empty.deleted.length, 0);
    assert.ok(existsSync(path.join(shots, '01011111111.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retention can be disabled or shortened with environment variables', () => {
  assert.equal(screenshotRetentionMs({}), DEFAULT_SCREENSHOT_RETENTION_MS);
  assert.equal(screenshotRetentionMs({ SCREENSHOT_RETENTION_MS: '60000' }), 60_000);
  assert.equal(screenshotRetentionMs({ SCREENSHOT_RETENTION: 'off' }), 0);
  assert.equal(screenshotRetentionMs({ SCREENSHOT_RETENTION: '0' }), 0);
  assert.equal(screenshotRetentionMs({ SCREENSHOT_RETENTION_MS: '0' }), 0);
  // The switch wins over a numeric window.
  assert.equal(screenshotRetentionMs({ SCREENSHOT_RETENTION: 'off', SCREENSHOT_RETENTION_MS: '60000' }), 0);
});

test('disabled retention deletes nothing', () => {
  const dir = makeDir();
  try {
    const shots = path.join(dir, 'screenshots');
    const seen = ledger(dir, ['01011111111']);
    shot(shots, '01011111111.png', { ageMs: 2 * MINUTE });

    const result = pruneSentScreenshots({ screenshotsDir: shots, seenNumbersFile: seen, retentionMs: 0 });

    assert.equal(result.deleted.length, 0);
    assert.ok(existsSync(path.join(shots, '01011111111.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry run reports what would be deleted but keeps every file', () => {
  const dir = makeDir();
  try {
    const shots = path.join(dir, 'screenshots');
    const seen = ledger(dir, ['01011111111']);
    shot(shots, '01011111111.png', { ageMs: 2 * MINUTE });

    const result = pruneSentScreenshots({
      screenshotsDir: shots,
      seenNumbersFile: seen,
      retentionMs: MINUTE,
      dryRun: true
    });

    assert.deepEqual(result.deleted, ['01011111111.png']);
    assert.ok(result.freedBytes > 0);
    assert.ok(existsSync(path.join(shots, '01011111111.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing screenshots dir is a no-op', () => {
  const dir = makeDir();
  try {
    const seen = ledger(dir, ['01011111111']);
    const result = pruneSentScreenshots({
      screenshotsDir: path.join(dir, 'gone'),
      seenNumbersFile: seen,
      retentionMs: MINUTE
    });
    assert.deepEqual(result.deleted, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
