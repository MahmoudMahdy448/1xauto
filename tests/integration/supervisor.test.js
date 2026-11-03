// Process-level tests for scripts/monitor-supervisor.mjs.
//
// The supervisor starts scripts/monitor-agent.mjs and scripts/status-bot.mjs
// from its working directory, so each test builds a tiny workspace with stub
// children (a good one, a crashing one, a "already running" one) and runs the
// real supervisor on top. Telegram goes to the fake Bot API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { startFakeTelegram } from '../helpers/fake-telegram.mjs';
import { ROOT, baseEnv, killTree, sleep, spawnScript, tempRoot, waitFor } from '../helpers/process.mjs';

const ADMIN = '699397575';
const CHANNEL = '-1004357023695';

const ALIVE = 'setInterval(() => {}, 1000);\n';
const CRASH = 'process.exit(1);\n';
const ALREADY_RUNNING = 'process.exit(3);\n';

function workspace({ agent = ALIVE, bot = ALIVE, lock } = {}) {
  const root = tempRoot('supervisor');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'monitor-agent.mjs'), agent);
  writeFileSync(path.join(root, 'scripts', 'status-bot.mjs'), bot);
  if (lock) {
    writeFileSync(path.join(root, 'monitor-supervisor.pid'), JSON.stringify(lock, null, 2));
  }
  return root;
}

function startSupervisor(root, tg, { env = {} } = {}) {
  return spawnScript(path.join(ROOT, 'scripts/monitor-supervisor.mjs'), {
    cwd: root,
    env: baseEnv({
      telegramUrl: tg.baseUrl,
      root,
      extra: {
        MONITOR_BACKOFF_MS: '150',
        MONITOR_CRASH_WINDOW_MINUTES: '10',
        MONITOR_MAX_CRASHES: '2',
        MONITOR_SUPERVISOR_PID: path.join(root, 'monitor-supervisor.pid'),
        ...env
      }
    }),
    name: 'supervisor'
  });
}

function killPid(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
  } catch {
    // already gone
  }
}

function startedPids(output) {
  return [...output.stdout.matchAll(/(agent|status-bot) started \(PID (\d+)/g)].map((match) => ({
    name: match[1],
    pid: Number(match[2])
  }));
}

test('starts both children, and restarts one that dies', async () => {
  const root = workspace();
  const tg = await startFakeTelegram();
  const child = startSupervisor(root, tg);
  try {
    await waitFor(() => startedPids(child.output).length >= 2, { label: 'both children started' });
    const agent = startedPids(child.output).find((entry) => entry.name === 'agent');
    assert.ok(agent?.pid > 0);

    killPid(agent.pid);

    await waitFor(() => startedPids(child.output).filter((entry) => entry.name === 'agent').length >= 2, {
      label: 'agent restarted'
    });
    assert.match(child.output.stdout, /agent started \(PID \d+, restart\)/);

    await waitFor(() => tg.messages().some((message) => message.text.includes('monitor restarted · agent')), {
      label: 'restart notice'
    });
    const notice = tg.messages().find((message) => message.text.includes('monitor restarted · agent'));
    assert.equal(notice.chatId, ADMIN);
    assert.ok(!tg.messages().some((message) => message.chatId === CHANNEL), 'never reports to the channel');
  } finally {
    killTree(child);
    await sleep(200);
    await tg.stop();
  }
});

test('a child that keeps crashing is given up on after the limit', async () => {
  const root = workspace({ agent: CRASH });
  const tg = await startFakeTelegram();
  const child = startSupervisor(root, tg);
  try {
    await waitFor(() => tg.messages().some((message) => message.text.includes('MONITOR CHILD STOPPED · agent')), {
      label: 'give-up alert',
      timeout: 10_000
    });
    const alert = tg.messages().find((message) => message.text.includes('MONITOR CHILD STOPPED · agent'));
    assert.match(alert.text, /2 crashes in 10 min/);
    assert.match(alert.text, /node scripts\/monitor-supervisor\.mjs/);

    const starts = startedPids(child.output).filter((entry) => entry.name === 'agent').length;
    assert.equal(starts, 2, 'initial start plus one retry, then it must stop');

    await sleep(1200);
    assert.equal(startedPids(child.output).filter((entry) => entry.name === 'agent').length, 2);
    assert.equal(tg.messages().filter((message) => message.text.includes('MONITOR CHILD STOPPED · agent')).length, 1);
  } finally {
    killTree(child);
    await sleep(200);
    await tg.stop();
  }
});

test('a child reporting "another instance" is left alone, not restarted', async () => {
  const root = workspace({ agent: ALREADY_RUNNING });
  const tg = await startFakeTelegram();
  const child = startSupervisor(root, tg);
  try {
    await waitFor(() => child.output.stderr.includes('reported another instance'), { label: 'exit code 3 noticed' });
    await sleep(800);
    assert.equal(startedPids(child.output).filter((entry) => entry.name === 'agent').length, 1);
    assert.equal(tg.messages().filter((message) => message.text.includes('agent')).length, 0);
  } finally {
    killTree(child);
    await sleep(200);
    await tg.stop();
  }
});

test('a second supervisor refuses to run next to the first', async () => {
  const root = workspace();
  const tg = await startFakeTelegram();
  const first = startSupervisor(root, tg);
  try {
    await waitFor(() => first.output.stdout.includes('started PID'), { label: 'first supervisor' });
    const second = startSupervisor(root, tg);
    const code = await new Promise((resolve) => second.on('exit', resolve));
    assert.equal(code, 3);
    assert.match(second.output.stderr, /already running/);
  } finally {
    killTree(first);
    await sleep(200);
    await tg.stop();
  }
});

test('a lock left by a dead supervisor is taken over', async () => {
  const root = workspace({ lock: { pid: 999_999, startedAt: new Date().toISOString() } });
  const tg = await startFakeTelegram();
  const child = startSupervisor(root, tg);
  try {
    await waitFor(() => child.output.stdout.includes('started PID'), { label: 'supervisor start' });
    const lock = JSON.parse(readFileSync(path.join(root, 'monitor-supervisor.pid'), 'utf8'));
    assert.equal(lock.pid, child.pid);
  } finally {
    killTree(child);
    await sleep(200);
    await tg.stop();
  }
});

test('a stop flag closes the supervisor cleanly and reports it', async () => {
  const root = workspace();
  const tg = await startFakeTelegram();
  const child = startSupervisor(root, tg);
  try {
    await waitFor(() => startedPids(child.output).length >= 2, { label: 'both children started' });

    writeFileSync(path.join(root, '.pipeline-stop'), 'stop', 'utf8');
    const code = await new Promise((resolve) => child.on('exit', resolve));

    assert.equal(code, 0, 'a clean stop is not a crash');
    assert.match(child.output.stdout, /stop flag found/);
    assert.ok(!existsSync(path.join(root, '.pipeline-stop')), 'the flag is consumed');
    assert.ok(!existsSync(path.join(root, 'monitor-supervisor.pid')), 'the lock is released');

    const notice = tg.messages().find((message) => message.text.includes('pipeline stopped by operator'));
    assert.ok(notice, 'the operator is told the pipeline stopped');
    assert.equal(notice.chatId, ADMIN);
    assert.ok(!tg.messages().some((message) => message.chatId === CHANNEL));
  } finally {
    killTree(child);
    await sleep(200);
    await tg.stop();
  }
});

test('nothing is sent when the bot token is missing', async () => {
  const root = workspace({ agent: CRASH });
  const tg = await startFakeTelegram();
  const child = startSupervisor(root, tg, { env: { TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' } });
  try {
    await waitFor(() => (child.output.stderr.match(/exited \(code=1/g) || []).length >= 2, {
      label: 'agent crashed twice'
    });
    await sleep(500);
    assert.deepEqual(tg.messages(), []);
  } finally {
    killTree(child);
    await sleep(200);
    await tg.stop();
  }
});
