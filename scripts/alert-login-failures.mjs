#!/usr/bin/env node
// Alert when a batch is dominated by loginRejected failures — the signature of
// the site serving an anti-bot page (e.g. "Select a login option") to the VM's
// IP. Sends a Telegram alert once per batch per shard.
//
// Env:
//   SUMMARY_FILES                 comma-separated run-summary paths (default the 4 1xauto shards)
//   LOG_FILES                     comma-separated loop-log paths (optional; derived from summaries by default)
//   ALERT_STATE_FILE              dedup state (default alert-state.json)
//   ALERT_LOGIN_REJECTED_THRESHOLD  min loginRejected failures to alert (default 5)
//   ALERT_MAX_AGE_MINUTES           ignore summaries older than this (default 30, avoids stale alerts)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_CHANNEL_ID
//
// CLI:
//   node scripts/alert-login-failures.mjs --test   send a sample alert, then exit
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { sendTelegramMessage } from '../lib/telegram.js';

const testMode = process.argv.includes('--test');
const threshold = parseInt(process.env.ALERT_LOGIN_REJECTED_THRESHOLD, 10) || 5;
const maxAgeMinutes = parseInt(process.env.ALERT_MAX_AGE_MINUTES, 10) || 30;

const defaultSummaries = [
  'run-summary-shard-1.json',
  'run-summary-shard-2.json',
  'run-summary-shard-3.json',
  'run-summary-shard-4.json'
];
const summaryFiles = (process.env.SUMMARY_FILES || defaultSummaries.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => path.resolve(process.cwd(), s));

const explicitLogFiles = (process.env.LOG_FILES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function labelFor(summaryPath) {
  const base = path.basename(summaryPath);
  if (base.startsWith('run-summary-')) {
    return base.slice('run-summary-'.length, -'.json'.length);
  }
  return base.replace(/\.json$/, '');
}

function logFileFor(summaryPath) {
  const base = path.basename(summaryPath);
  if (base.startsWith('run-summary-')) {
    const suffix = base.slice('run-summary-'.length, -'.json'.length);
    return path.resolve(path.dirname(summaryPath), `loop-log-${suffix}.txt`);
  }
  return null;
}

function readLogLines(logPath) {
  if (!logPath || !existsSync(logPath)) return [];
  try {
    return readFileSync(logPath, 'utf8').split('\n');
  } catch {
    return [];
  }
}

function findSignature(lines) {
  const matches = lines.filter((l) => l.includes('Select a login option'));
  const suspicious = lines.filter((l) => l.includes('Suspicious activity'));
  const sample = matches.length
    ? matches[matches.length - 1].match(/account=([^\]]+)\].*$/)
    : null;
  return {
    matches: matches.length,
    suspicious: suspicious.length,
    sampleAccount: sample ? sample[1].trim() : null
  };
}

async function sendAlert(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!botToken || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required.');
    process.exit(1);
  }
  // Text alerts are operational reporting: admin chat only, never the channel.
  const recipients = [chatId];
  for (const recipient of recipients) {
    await sendTelegramMessage({ botToken, chatId: recipient, text });
  }
}

async function main() {
  if (testMode) {
    const text = [
      'TEST ALERT — 1xauto login failure monitor is live',
      'This confirms Telegram delivery for the anti-bot login-failure alert.',
      'It will fire when a batch hits the threshold of ' + threshold + ' loginRejected failures.'
    ].join('\n');
    await sendAlert(text);
    console.log('Test alert sent.');
    process.exit(0);
  }

  const stateFile = path.resolve(process.cwd(), process.env.ALERT_STATE_FILE || 'alert-state.json');
  const state = readJson(stateFile) || { alerted: {} };
  let scanned = 0;

  for (let i = 0; i < summaryFiles.length; i += 1) {
    const summaryPath = summaryFiles[i];
    const summary = readJson(summaryPath);
    if (!summary) continue;

    const endedAt = Date.parse(summary.endedAt || '');
    if (!Number.isFinite(endedAt) || Date.now() - endedAt > maxAgeMinutes * 60_000) continue;
    scanned += 1;

    const rejected = summary.failureCategories?.loginRejected ?? 0;
    if (rejected < threshold) continue;

    const label = labelFor(summaryPath);
    const key = `${label}:${summary.batchId || 'unknown'}`;
    if (state.alerted[key]) continue;

    const logPath = explicitLogFiles[i] || logFileFor(summaryPath);
    const signature = findSignature(readLogLines(logPath));

    const rate = summary.succeeded + summary.failed > 0
      ? ((summary.succeeded / (summary.succeeded + summary.failed)) * 100).toFixed(1)
      : 'n/a';
    const lines = [
      'ALERT: 1xauto login failure storm (likely anti-bot)',
      `Shard: ${label}`,
      `Batch: ${summary.batchId || 'n/a'}`,
      `Result: ${summary.succeeded} ok / ${summary.failed} failed (${rate}% success)`,
      `Login rejected (anti-bot): ${rejected}`
    ];
    if (signature.matches > 0) {
      lines.push(`"Select a login option" in log: ${signature.matches}x`);
    }
    if (signature.suspicious > 0) {
      lines.push('"Suspicious activity detected" seen in log');
    }
    if (signature.sampleAccount) {
      lines.push(`Sample account: ${signature.sampleAccount}`);
    }
    lines.push('Likely cause: eg1xbet flagged this VM\u2019s IP. Rotate the public IP and re-test.');

    try {
      await sendAlert(lines.join('\n'));
      state.alerted[key] = new Date().toISOString();
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
      console.log(`Alerted for ${key}.`);
    } catch (error) {
      console.error(`Failed to alert for ${key}: ${error.message}`);
    }
  }

  if (scanned > 0) {
    console.log(`monitor: scanned ${scanned} recent summary file(s), no login-failure alerts.`);
  }
}

main();
