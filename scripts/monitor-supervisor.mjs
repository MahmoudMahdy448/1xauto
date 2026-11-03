// monitor-supervisor.mjs — keeps the monitor agent and the status bot alive.
//
// Nothing watches the supervisor (documented limitation). It restarts a child
// with a short backoff, sends one notice per restart, and after 3 crashes in
// 10 minutes it sends one critical alert and stops retrying that child.

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { sendTelegramMessage } from '../lib/telegram.js';

dotenv.config();

const ROOT = process.cwd();
const LOCK_FILE = path.resolve(ROOT, process.env.MONITOR_SUPERVISOR_PID || 'monitor-supervisor.pid');
// Written by scripts/stop-pipeline.ps1. SIGTERM is not a usable shutdown
// signal on Windows (process.kill there is a hard terminate), so the operator
// stop is a file the supervisor watches instead.
const STOP_FILE = path.resolve(ROOT, process.env.MONITOR_STOP_FILE || '.pipeline-stop');
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

const CHILDREN = [
  { name: 'agent', script: 'scripts/monitor-agent.mjs' },
  { name: 'status-bot', script: 'scripts/status-bot.mjs' }
];

const BACKOFF_MS = (process.env.MONITOR_BACKOFF_MS || '5000,15000,45000,120000')
  .split(',')
  .map((value) => parseInt(value, 10))
  .filter((value) => Number.isFinite(value));
const CRASH_WINDOW_MS = (parseInt(process.env.MONITOR_CRASH_WINDOW_MINUTES, 10) || 10) * 60_000;
const MAX_CRASHES = parseInt(process.env.MONITOR_MAX_CRASHES, 10) || 3;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      if (lock?.pid && pidAlive(lock.pid)) {
        console.error(`[monitor-supervisor] already running as PID ${lock.pid} — exiting.`);
        process.exit(3);
      }
    }
  } catch {
    // stale lock
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
}

function releaseLock() {
  try {
    const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (lock?.pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

async function notify(text) {
  if (!botToken || !chatId) return;
  try {
    await sendTelegramMessage({ botToken, chatId, text });
  } catch (error) {
    console.error(`[monitor-supervisor] could not send notice: ${error.message}`);
  }
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

class Child {
  constructor({ name, script }) {
    this.name = name;
    this.script = script;
    this.proc = null;
    this.startedAt = null;
    this.crashes = [];
    this.givenUp = false;
    this.restartTimer = null;
  }

  start(reason = 'initial') {
    if (this.givenUp) return;

    this.proc = spawn(process.execPath, [this.script], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env
    });
    this.startedAt = Date.now();
    console.log(`[monitor-supervisor] ${this.name} started (PID ${this.proc.pid}, ${reason})`);

    if (reason === 'restart') {
      const downMs = this.lastExitAt ? Date.now() - this.lastExitAt : 0;
      notify(`ℹ️ monitor restarted · ${this.name} · was down ${formatDuration(downMs)} · ${this.crashes.length} restart(s) in 10 min`);
    }

    this.proc.on('error', (error) => {
      console.error(`[monitor-supervisor] ${this.name} failed to start: ${error.message}`);
    });

    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      this.lastExitAt = Date.now();
      // Code 3 means "another instance is already running" — do not fight it.
      if (code === 3) {
        console.error(`[monitor-supervisor] ${this.name} reported another instance — leaving it alone.`);
        return;
      }
      if (this.stopping) return;

      const now = Date.now();
      this.crashes = this.crashes.filter((ts) => now - ts < CRASH_WINDOW_MS);
      this.crashes.push(now);
      console.error(`[monitor-supervisor] ${this.name} exited (code=${code}, signal=${signal})`);

      if (this.crashes.length >= MAX_CRASHES) {
        this.givenUp = true;
        notify(
          [
            `🔴 MONITOR CHILD STOPPED · ${this.name}`,
            `${this.crashes.length} crashes in 10 min — giving up until the supervisor is restarted`,
            'run: node scripts/monitor-supervisor.mjs'
          ].join('\n')
        );
        return;
      }

      const delay = BACKOFF_MS[Math.min(this.crashes.length - 1, BACKOFF_MS.length - 1)];
      console.log(`[monitor-supervisor] restarting ${this.name} in ${delay / 1000}s`);
      this.restartTimer = setTimeout(() => this.start('restart'), delay);
    });
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // gone
      }
    }
  }
}

acquireLock();

const children = CHILDREN.map((def) => new Child(def));
for (const child of children) child.start();

let stopWatch = null;

function shutdown() {
  if (stopWatch) clearInterval(stopWatch);
  for (const child of children) child.stop();
  releaseLock();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[monitor-supervisor] started PID ${process.pid} · watching ${children.length} children`);

// Operator stop: say so once, then close. The flag is removed so the next
// start is clean even if this process was already gone.
stopWatch = setInterval(async () => {
  if (!existsSync(STOP_FILE)) return;
  clearInterval(stopWatch);
  stopWatch = null;
  console.log('[monitor-supervisor] stop flag found — shutting down');
  await notify('🛑 pipeline stopped by operator · monitor agent and status bot closed');
  try {
    unlinkSync(STOP_FILE);
  } catch {
    // someone else already removed it
  }
  shutdown();
}, 1000);
