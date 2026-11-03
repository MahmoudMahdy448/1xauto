// Helpers shared by the process-level tests: temp workspaces, polling and
// killing whole process trees on Windows.

import { execFileSync, spawn } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

export const ROOT = path.resolve(process.cwd());

export function tempRoot(prefix = '1xauto-test') {
  return mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export function writeEventFile(dir, name, events) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, events.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');
  return file;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Current hour in the monitoring time zone, so tests are independent of the
// machine clock and of when they are run.
export function cairoHour(date = new Date(), timeZone = 'Africa/Cairo') {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(date);
  return Number(hour) % 24;
}

export async function waitFor(predicate, { timeout = 10_000, interval = 100, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) {
      throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
    }
    await sleep(interval);
  }
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {
      // fall through to SIGTERM
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
}

// Spawns a project script with a controlled environment. stdout/stderr are
// captured so a failing test can show what the child logged.
export function spawnScript(script, { cwd = ROOT, env = {}, name = script } = {}) {
  const child = spawn(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    child.output.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    child.output.stderr += chunk.toString();
  });
  child.label = name;
  return child;
}

// An environment that cannot reach the real Telegram or the real repo state.
// Quiet hours are neutralised and the daily ping is pushed to another hour, so
// a test behaves the same at 03:00 and at 09:00 Cairo.
export function baseEnv({ telegramUrl, root, extra = {} }) {
  const notNow = (cairoHour() + 3) % 24;
  return {
    TELEGRAM_BOT_TOKEN: '111:test-token',
    TELEGRAM_CHAT_ID: '699397575',
    TELEGRAM_CHANNEL_ID: '-1004357023695',
    TELEGRAM_API_BASE: telegramUrl,
    MONITOR_STATE_FILE: path.join(root, 'monitor-state.json'),
    ALERT_CONTROL_FILE: path.join(root, 'alert-control.json'),
    MONITOR_AGENT_PID: path.join(root, 'monitor-agent.pid'),
    SEEN_NUMBERS_FILE: path.join(root, 'seen-numbers.json'),
    EVENTS_DIR: path.join(root, 'events'),
    MONITOR_TICK_MS: '150',
    MONITOR_STARTUP_GRACE_MINUTES: '0',
    ALERT_QUIET_START_HOUR: '0',
    ALERT_QUIET_END_HOUR: '0',
    ALERT_DAILY_PING_HOUR: String(notNow),
    ...extra
  };
}

// Event envelope used by the synthetic producers in the tests.
export function event(svc, role, kind, data = {}, extra = {}) {
  return {
    ts: new Date().toISOString(),
    svc,
    role,
    inst: '1',
    kind,
    ...extra,
    data
  };
}
