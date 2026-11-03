import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  PaymentDisabledError,
  buildAlertText,
  buildProbeBrokenText,
  buildStillDownText,
  channelCaption,
  markDisabled,
  markEnabled,
  markProbeFailed,
  markReminderSent,
  markStillDisabled,
  matchesRestriction,
  parseLadder,
  readGate,
  reminderDue
} from '../../lib/deposit-gate.js';
import { classifyError, isRetryable } from '../../lib/retry.js';

function tempEnv(overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deposit-gate-'));
  return {
    env: { GATE_FILE: path.join(dir, 'deposit-gate.json'), ...overrides },
    dir
  };
}

test('matchesRestriction: recognizes the site restriction message', () => {
  assert.equal(
    matchesRestriction('This method is not available due to technical issues'),
    true
  );
  assert.equal(matchesRestriction('  THIS METHOD IS NOT AVAILABLE DUE TO TECHNICAL ISSUES '), true);
  assert.equal(matchesRestriction('Payment method currently unavailable'), true);
  assert.equal(matchesRestriction('Enter your phone number'), false);
  assert.equal(matchesRestriction(''), false);
  assert.equal(matchesRestriction(null), false);
});

test('parseLadder: reads the env ladder and falls back to 5,15,15,15', () => {
  assert.deepEqual(parseLadder('5,15,15,15'), [5, 15, 15, 15]);
  assert.deepEqual(parseLadder(' 2, 7 ,9 '), [2, 7, 9]);
  assert.deepEqual(parseLadder(''), [5, 15, 15, 15]);
  assert.deepEqual(parseLadder(undefined), [5, 15, 15, 15]);
  assert.deepEqual(parseLadder('nope'), [5, 15, 15, 15]);
});

test('markDisabled: records the transition, first check in 5 min, alert once', () => {
  const { env, dir } = tempEnv();
  try {
    const before = Date.now();
    const result = markDisabled(
      {
        reason: 'This method is not available due to technical issues',
        account: '22 asyutaccjul722@',
        shard: 'shard-1',
        screenshots: ['screenshots/gate/grid.png']
      },
      env
    );

    assert.equal(result.changed, true);
    assert.equal(result.notify, true);
    assert.equal(result.gate.disabled, true);
    assert.equal(result.gate.detectedBy.account, '22 asyutaccjul722@');
    assert.deepEqual(result.gate.screenshots, ['screenshots/gate/grid.png']);
    assert.equal(result.gate.ladderIndex, 0);
    assert.equal(result.gate.probeFailures, 0);

    const nextMs = Date.parse(result.gate.nextCheckAt) - before;
    assert.ok(nextMs >= 4.9 * 60_000 && nextMs <= 5.1 * 60_000, `next check ${nextMs}ms`);

    const reminderMs = Date.parse(result.gate.reminderAt) - before;
    assert.ok(reminderMs >= 59.9 * 60_000 && reminderMs <= 60.1 * 60_000, `reminder ${reminderMs}ms`);

    // State survives the round trip to disk.
    const onDisk = JSON.parse(readFileSync(env.GATE_FILE, 'utf8'));
    assert.equal(onDisk.disabled, true);
    assert.equal(readGate(env).disabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markDisabled: a second detection neither rewrites the state nor re-alerts', () => {
  const { env, dir } = tempEnv();
  try {
    const first = markDisabled({ account: 'a', shard: 'shard-1' }, env);
    const second = markDisabled({ account: 'b', shard: 'shard-2' }, env);

    assert.equal(second.changed, false);
    assert.equal(second.notify, false);
    assert.equal(second.gate.since, first.gate.since);
    assert.equal(second.gate.detectedBy.account, 'a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markStillDisabled: walks the ladder to 15 min and keeps the evidence', () => {  const { env, dir } = tempEnv({ GATE_CHECK_LADDER_MINUTES: '5,15,15,15' });
  try {
    markDisabled({ screenshots: ['first.png'] }, env);

    const step1 = markStillDisabled({ screenshots: ['probe.png'] }, env);
    assert.equal(step1.gate.ladderIndex, 1);
    assert.equal(step1.gate.probeCount, 1);
    assert.equal(step1.gate.probeFailures, 0);
    assert.deepEqual(step1.gate.screenshots, ['probe.png']);
    const gap1 = Date.parse(step1.gate.nextCheckAt) - Date.parse(step1.gate.lastCheckedAt);
    assert.equal(gap1, 15 * 60_000);

    const step2 = markStillDisabled({}, env);
    assert.equal(step2.gate.ladderIndex, 2);
    // No new evidence: the previous screenshot is kept for reminders.
    assert.deepEqual(step2.gate.screenshots, ['probe.png']);

    // Past the end of the ladder the last step repeats.
    markStillDisabled({}, env);
    const step4 = markStillDisabled({}, env);
    const gap4 = Date.parse(step4.gate.nextCheckAt) - Date.parse(step4.gate.lastCheckedAt);
    assert.equal(gap4, 15 * 60_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markStillDisabled: ignores a gate that a successful account already cleared', () => {
  const { env, dir } = tempEnv();
  try {
    const result = markStillDisabled({}, env);
    assert.equal(result.changed, false);
    assert.equal(readGate(env).disabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reminder: due after 60 minutes, then pushed forward', () => {
  const { env, dir } = tempEnv({ GATE_REMINDER_MINUTES: '60' });
  try {
    const gate = markDisabled({}, env).gate;
    assert.equal(reminderDue(gate, new Date(Date.now() + 59 * 60_000)), false);
    assert.equal(reminderDue(gate, new Date(Date.now() + 61 * 60_000)), true);

    const updated = markReminderSent(env);
    assert.ok(updated.lastReminderAt);
    assert.equal(reminderDue(updated, new Date()), false);
    assert.equal(reminderDue(updated, new Date(Date.now() + 61 * 60_000)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markProbeFailed: backs off and warns exactly on the third failure in a row', () => {
  const { env, dir } = tempEnv();
  try {
    markDisabled({}, env);

    const first = markProbeFailed({ error: 'login failed' }, env);
    assert.equal(first.gate.probeFailures, 1);
    assert.equal(first.shouldAlertProbeBroken, false);
    const second = markProbeFailed({ error: 'login failed' }, env);
    assert.equal(second.shouldAlertProbeBroken, false);
    const third = markProbeFailed({ error: 'timeout' }, env);
    assert.equal(third.gate.probeFailures, 3);
    assert.equal(third.shouldAlertProbeBroken, true);
    assert.equal(third.gate.lastProbeError, 'timeout');

    const backoff = Date.parse(third.gate.nextCheckAt) - Date.parse(third.gate.lastCheckedAt);
    assert.equal(backoff, 10 * 60_000);

    const fourth = markProbeFailed({}, env);
    assert.equal(fourth.shouldAlertProbeBroken, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markEnabled: clears the gate once and reports the outage', () => {
  const { env, dir } = tempEnv();
  try {
    markDisabled({}, env);
    const restored = markEnabled({ account: '252 elminyaaccjul7252@', shard: 'shard-2' }, env);

    assert.equal(restored.changed, true);
    assert.equal(restored.notify, true);
    assert.equal(restored.gate.disabled, false);
    assert.equal(restored.gate.restoredBy.account, '252 elminyaaccjul7252@');
    assert.ok(restored.gate.restoredAt);

    const again = markEnabled({}, env);
    assert.equal(again.changed, false);
    assert.equal(again.notify, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PaymentDisabledError: classified as non-retryable paymentDisabled', () => {
  const error = new PaymentDisabledError();
  assert.equal(error.code, 'PAYMENT_METHOD_DISABLED');
  assert.ok(error.message.startsWith('PAYMENT_METHOD_DISABLED'));

  const classified = classifyError(error);
  assert.equal(classified.category, 'paymentDisabled');
  assert.equal(classified.retryable, false);
  assert.equal(isRetryable(error), false);
});

test('alert text: names the shard, the local time and the next check', () => {
  const gate = {
    since: '2026-11-01T09:00:00.000Z',
    restoredAt: '2026-11-01T10:30:00.000Z',
    nextCheckAt: '2026-11-01T09:15:00.000Z',
    lastCheckedAt: '2026-11-01T09:05:00.000Z',
    detectedBy: { shard: 'shard-1', account: '22 asyutaccjul722@' },
    reason: 'This method is not available due to technical issues',
    probeCount: 3
  };

  const disabled = buildAlertText('disabled', gate);
  assert.match(disabled, /Vodafone deposit disabled/);
  assert.match(disabled, /shard-1 \(22 asyutaccjul722@\)/);
  assert.match(disabled, /Flow paused/);

  const enabled = buildAlertText('enabled', gate);
  assert.match(enabled, /is back/);
  assert.match(enabled, /90 min/);

  assert.match(channelCaption('disabled', gate), /^⛔ vodafone disabled \d{2}:\d{2}$/);
  assert.match(channelCaption('enabled', gate), /^✅ vodafone back \d{2}:\d{2}$/);

  const broken = buildProbeBrokenText({ probeFailures: 3, lastProbeError: 'timeout' });
  assert.match(broken, /probe is failing/);
  assert.match(broken, /timeout/);
  assert.match(broken, /Accounts stay paused/);
});

test('still-down heartbeat: one short admin line per probe', () => {
  const gate = {
    since: '2026-11-01T09:00:00.000Z',
    lastCheckedAt: '2026-11-01T09:30:00.000Z',
    nextCheckAt: '2026-11-01T09:45:00.000Z',
    reminderAt: '2026-11-01T10:00:00.000Z',
    probeCount: 2
  };

  const text = buildStillDownText(gate);
  assert.match(text, /Vodafone still down/);
  assert.match(text, /30 min down/);
  assert.match(text, /check #2/);
  assert.match(text, /Next probe/);
  assert.match(text, /reminder/);
  assert.equal(text.split('\n').length, 3);
});
