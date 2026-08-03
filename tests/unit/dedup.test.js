import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimNewNumbers, readSeenNumbers } from '../../lib/dedup.js';

function makeDir() {
  return mkdtempSync(path.join(os.tmpdir(), '1xauto-dedup-'));
}

test('claimNewNumbers claims only unseen numbers', async () => {
  const dir = makeDir();
  try {
    const ledger = path.join(dir, 'seen.json');
    const lock = path.join(dir, 'seen.lock');

    const first = await claimNewNumbers({ filePath: ledger, lockPath: lock, numbers: ['01011111111', '01022222222'] });
    assert.deepEqual([...first].sort(), ['01011111111', '01022222222']);

    const second = await claimNewNumbers({ filePath: ledger, lockPath: lock, numbers: ['01011111111', '01033333333'] });
    assert.deepEqual([...second], ['01033333333']);

    const seen = readSeenNumbers(ledger);
    assert.equal(seen.size, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimNewNumbers is atomic across concurrent claims (dedupes cross-shard)', async () => {
  const dir = makeDir();
  try {
    const ledger = path.join(dir, 'seen.json');
    const lock = path.join(dir, 'seen.lock');
    const all = Array.from({ length: 20 }, (_, i) => `01${String(1000000000 + i)}`);

    const [a, b] = await Promise.all([
      claimNewNumbers({ filePath: ledger, lockPath: lock, numbers: all.slice(0, 10) }),
      claimNewNumbers({ filePath: ledger, lockPath: lock, numbers: all.slice(5, 15) })
    ]);

    const overlap = a.filter((n) => b.includes(n));
    assert.equal(overlap.length, 0);
    assert.equal(readSeenNumbers(ledger).size, 15);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimNewNumbers works on an empty ledger', async () => {
  const dir = makeDir();
  try {
    const ledger = path.join(dir, 'seen.json');
    const lock = path.join(dir, 'seen.lock');
    const first = await claimNewNumbers({ filePath: ledger, lockPath: lock, numbers: [] });
    assert.deepEqual(first, []);
    assert.equal(readSeenNumbers(ledger).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
