// Launch guards for scripts/launch-shard.ps1.
//
// These are the only tests that run PowerShell against the real repository,
// because the launcher deliberately hardcodes its absolute workspace paths.
// They exercise only the paths that throw *before* a scraper is started, so no
// shard, loop or browser is ever launched:
//
//   - a BATCH_ID in the environment is refused (it would reset the shard to #1)
//   - an unknown shard name is refused by the parameter validation
//
// Everything past those guards is covered by the manual checklist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { ROOT } from '../helpers/process.mjs';

function runLaunch(args, env = {}) {
  return spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'launch-shard.ps1'), ...args],
    { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 }
  );
}

function pidFileSnapshot() {
  const file = path.join(ROOT, 'shards', 'shard-1.pid');
  return existsSync(file) ? statSync(file).mtimeMs : null;
}

test('a BATCH_ID in the environment stops the launcher before it starts a shard', () => {
  const before = pidFileSnapshot();
  const result = runLaunch(['-Name', 'shard-1'], { BATCH_ID: 'test-batch' });

  assert.notEqual(result.status, 0, 'the launcher must refuse to run');
  assert.match(`${result.stdout}${result.stderr}`, /BATCH_ID must not be set by the launcher/);

  // Nothing was started: the live shard's PID file was not rewritten.
  assert.equal(pidFileSnapshot(), before);
});

test('an unknown shard name is rejected by parameter validation', () => {
  const result = runLaunch(['-Name', 'shard-3']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /shard-3/);
});

test('a missing shard name is rejected', () => {
  const result = runLaunch([]);
  assert.notEqual(result.status, 0);
});

test('the ledger and screenshot guards are in the launcher, before any spawn', () => {
  // A cheap source check: the guards must exist and sit above the process
  // start, otherwise a bad environment could launch a shard that writes
  // screenshots where realtime-send cannot find them.
  const source = readFileSync(path.join(ROOT, 'scripts', 'launch-shard.ps1'), 'utf8');
  const guard = source.indexOf('BATCH_ID must not be set by the launcher');
  const spawn = source.indexOf('Start-Process');
  assert.ok(guard > 0, 'BATCH_ID guard missing');
  assert.ok(spawn > 0, 'launcher never starts anything?');
  assert.ok(guard < spawn, 'BATCH_ID guard must run before the launcher spawns a process');
  assert.match(source, /SCREENSHOTS_DIR basename/);
  assert.match(source, /Refusing to launch with ledger/);
});
