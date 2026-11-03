import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  SiteBlockedError,
  blockDue,
  blockFilePath,
  buildSiteBlockText,
  buildSiteUnblockedText,
  emptyBlock,
  markSiteBlocked,
  markSiteUnblocked,
  matchesSiteBlock,
  parseBlockLadder,
  readSiteBlock
} from '../../lib/site-block.js';
import { classifyError, isRetryable } from '../../lib/retry.js';

function tempEnv(overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'site-block-'));
  return {
    dir,
    env: { SITE_BLOCK_FILE: path.join(dir, 'site-block.json'), ...overrides }
  };
}

function expire(env) {
  // Move the deadline into the past: the only way to test the ladder without
  // waiting an hour. markSiteBlocked reads the file, so the edit is real.
  const file = blockFilePath(env);
  const block = JSON.parse(readFileSync(file, 'utf8'));
  block.blockedUntil = new Date(Date.now() - 1000).toISOString();
  writeFileSync(file, JSON.stringify(block));
  return block;
}

test('matchesSiteBlock: recognizes the modal, ignores ordinary failures', () => {
  assert.equal(matchesSiteBlock('Suspicious activity detected. Try again later.'), true);
  assert.equal(matchesSiteBlock('  SUSPICIOUS ACTIVITY DETECTED '), true);
  assert.equal(matchesSiteBlock('Try again later'), true);
  assert.equal(matchesSiteBlock('Login failed: invalid password'), false);
  assert.equal(matchesSiteBlock('This method is not available due to technical issues'), false);
  assert.equal(matchesSiteBlock(''), false);
  assert.equal(matchesSiteBlock(null), false);
});

test('parseBlockLadder: reads the env ladder and falls back to 15,30,60,120', () => {
  assert.deepEqual(parseBlockLadder('5,10,20'), [5, 10, 20]);
  assert.deepEqual(parseBlockLadder(' 15 , 30 '), [15, 30]);
  assert.deepEqual(parseBlockLadder(undefined), [15, 30, 60, 120]);
  assert.deepEqual(parseBlockLadder('junk,0,-3'), [15, 30, 60, 120]);
});

test('SiteBlockedError: code and message prefix match the retry rule', () => {
  const error = new SiteBlockedError();
  assert.equal(error.code, 'SITE_BLOCKED');
  assert.match(error.message, /^SITE_BLOCKED/);
  assert.match(new SiteBlockedError('Suspicious activity').message, /^SITE_BLOCKED: Suspicious activity/);
});

test('readSiteBlock: missing file and corrupt JSON both fall back to an open breaker', () => {
  const { dir, env } = tempEnv();
  try {
    assert.deepEqual(readSiteBlock(env), emptyBlock());

    writeFileSync(blockFilePath(env), '{not json');
    const parsed = readSiteBlock(env);
    assert.equal(parsed.blocked, false);
    assert.equal(parsed.blockCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSiteBlock: a UTF-8 BOM does not disable the breaker', () => {
  const { dir, env } = tempEnv();
  try {
    const block = { ...emptyBlock(), blocked: true, blockedUntil: new Date(Date.now() + 60_000).toISOString(), blockCount: 1 };
    writeFileSync(blockFilePath(env), `\uFEFF${JSON.stringify(block)}`);
    const parsed = readSiteBlock(env);
    assert.equal(parsed.blocked, true);
    assert.equal(parsed.blockCount, 1);
    assert.equal(blockDue(parsed), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markSiteBlocked: first block parks for 15 min and alerts', () => {
  const { dir, env } = tempEnv();
  try {
    const before = Date.now();
    const result = markSiteBlocked(
      { reason: 'Suspicious activity detected.', account: 'a@b.c', shard: 'shard-1' },
      env
    );

    assert.equal(result.changed, true);
    assert.equal(result.shouldAlert, true);
    assert.equal(result.block.blocked, true);
    assert.equal(result.block.blockCount, 1);
    assert.equal(result.block.reason, 'Suspicious activity detected.');
    assert.deepEqual(result.block.detectedBy, { account: 'a@b.c', shard: 'shard-1' });

    const waitMs = Date.parse(result.block.blockedUntil) - before;
    assert.ok(waitMs > 14 * 60_000 && waitMs <= 15 * 60_000 + 2000, `wait was ${waitMs}ms`);
    assert.equal(readSiteBlock(env).blocked, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markSiteBlocked: a second shard inside the window is merged, not re-alerted', () => {
  const { dir, env } = tempEnv();
  try {
    const first = markSiteBlocked({ account: 'one@x', shard: 'shard-1' }, env);
    const second = markSiteBlocked({ account: 'two@x', shard: 'shard-2' }, env);

    assert.equal(second.changed, false);
    assert.equal(second.shouldAlert, false);
    assert.equal(second.block.blockCount, 1);
    assert.equal(second.block.blockedUntil, first.block.blockedUntil);
    assert.equal(second.block.detectedBy.account, 'one@x');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markSiteBlocked: the ladder grows 15 -> 30 -> 60 -> 120 and then holds', () => {
  const { dir, env } = tempEnv();
  try {
    const expected = [15, 30, 60, 120, 120];
    for (const [i, minutes] of expected.entries()) {
      if (i > 0) expire(env);
      const before = Date.now();
      const result = markSiteBlocked({ account: `a${i}@x`, shard: 'shard-1' }, env);
      assert.equal(result.block.blockCount, i + 1);
      const waitMs = Date.parse(result.block.blockedUntil) - before;
      assert.ok(
        waitMs > (minutes - 1) * 60_000 && waitMs <= minutes * 60_000 + 2000,
        `block #${i + 1} waited ${Math.round(waitMs / 60_000)}min, expected ${minutes}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markSiteBlocked: honors a custom ladder from the env', () => {
  const { dir, env } = tempEnv({ SITE_BLOCK_LADDER_MINUTES: '1,2' });
  try {
    const first = markSiteBlocked({ account: 'a@x', shard: 'shard-1' }, env);
    assert.ok(Date.parse(first.block.blockedUntil) - Date.now() <= 60_000 + 2000);

    expire(env);
    const second = markSiteBlocked({ account: 'b@x', shard: 'shard-1' }, env);
    assert.ok(Date.parse(second.block.blockedUntil) - Date.now() <= 120_000 + 2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blockDue: false while parked, true once the deadline passes', () => {
  const { dir, env } = tempEnv();
  try {
    const result = markSiteBlocked({ account: 'a@x', shard: 'shard-1' }, env);
    assert.equal(blockDue(result.block), false);
    assert.equal(blockDue(result.block, new Date(Date.parse(result.block.blockedUntil) + 1000)), true);
    assert.equal(blockDue(emptyBlock()), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markSiteUnblocked: clears the breaker, resets the ladder and records who proved it', () => {
  const { dir, env } = tempEnv();
  try {
    markSiteBlocked({ account: 'a@x', shard: 'shard-1' }, env);
    const result = markSiteUnblocked({ account: 'ok@x', shard: 'shard-2' }, env);

    assert.equal(result.changed, true);
    assert.equal(result.block.blocked, false);
    assert.equal(result.block.blockedUntil, null);
    assert.equal(result.block.blockCount, 0);
    assert.equal(result.block.screenshot, null);
    assert.ok(result.block.recoveredAt);
    assert.deepEqual(result.block.recoveredBy, { account: 'ok@x', shard: 'shard-2' });

    const again = markSiteUnblocked({ account: 'ok2@x', shard: 'shard-2' }, env);
    assert.equal(again.changed, false);

    // The next block starts the ladder over.
    const next = markSiteBlocked({ account: 'b@x', shard: 'shard-1' }, env);
    assert.equal(next.block.blockCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markSiteBlocked / markSiteUnblocked leave no .tmp or .lock files', () => {
  const { dir, env } = tempEnv();
  try {
    markSiteBlocked({ account: 'a@x', shard: 'shard-1' }, env);
    markSiteUnblocked({ account: 'a@x', shard: 'shard-1' }, env);
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSiteBlockText: says what happened, who saw it, and when it retries', () => {
  const { dir, env } = tempEnv();
  try {
    const result = markSiteBlocked(
      { reason: 'Suspicious activity detected. Try again later.', account: 'a@b.c', shard: 'shard-1' },
      env
    );
    const text = buildSiteBlockText(result.block);
    assert.match(text, /⛔ 1xbet is blocking this IP/);
    assert.match(text, /Suspicious activity detected/);
    assert.match(text, /shard-1 \(a@b\.c\)/);
    assert.match(text, /No accounts will be opened for \d+ min/);
    assert.match(text, /If this happens again, the IP needs a proxy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSiteBlockText: a repeat block spells out that the IP needs a proxy', () => {
  const { dir, env } = tempEnv();
  try {
    markSiteBlocked({ account: 'a@x', shard: 'shard-1' }, env);
    expire(env);
    const second = markSiteBlocked({ account: 'a@x', shard: 'shard-1' }, env);
    assert.match(buildSiteBlockText(second.block), /This is block #2 — the IP needs a proxy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSiteUnblockedText: confirms recovery and names the account', () => {
  const { dir, env } = tempEnv();
  try {
    markSiteBlocked({ account: 'a@x', shard: 'shard-1' }, env);
    const { block } = markSiteUnblocked({ account: 'ok@x', shard: 'shard-2' }, env);
    const text = buildSiteUnblockedText(block);
    assert.match(text, /✅ 1xbet is accepting logins again/);
    assert.match(text, /shard-2 \(ok@x\)/);
    assert.match(text, /Farm resumed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyError: SITE_BLOCKED is its own non-retryable category', () => {
  const error = new SiteBlockedError('Suspicious activity detected.');
  const result = classifyError(error);
  assert.equal(result.category, 'siteBlocked');
  assert.equal(result.retryable, false);
  assert.equal(isRetryable(error), false);

  // And it wins over the generic login failure rule.
  const both = new SiteBlockedError('Suspicious activity detected. Login failed: nope');
  assert.equal(classifyError(both).category, 'siteBlocked');

  // The login path can wrap the phrase in its own error string when the modal
  // renders late. That must still stop the farm, not count as a bad account.
  const wrapped = new Error('Login failed: Suspicious activity detected. Try again later.');
  assert.equal(classifyError(wrapped).category, 'siteBlocked');
  assert.equal(isRetryable(wrapped), false);
});

test('classifyError: a real credential rejection is still loginRejected', () => {
  const result = classifyError(new Error('Login failed: invalid password'));
  assert.equal(result.category, 'loginRejected');
  assert.equal(result.retryable, false);
});
