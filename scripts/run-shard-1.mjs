#!/usr/bin/env node
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  sendTelegramPhotoWithRetry,
  sendTelegramMessage,
  extractNumberFromScreenshotName
} from '../lib/telegram.js';
import { claimNewNumbers, releaseNumbers, readSeenNumbers } from '../lib/dedup.js';

dotenv.config();

const root = path.resolve(process.cwd());
const shardNum = 1;
const startIndex = parseInt(process.env.START_INDEX, 10) || 1;
const endIndex = parseInt(process.env.END_INDEX, 10) || 149;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const channelId = process.env.TELEGRAM_CHANNEL_ID;

if (!botToken || !chatId) {
  console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.');
  process.exit(1);
}

const recipients = channelId ? [chatId, channelId] : [chatId];

async function broadcastPhoto(photoPath, caption) {
  for (const recipient of recipients) {
    await sendTelegramPhotoWithRetry({ botToken, chatId: recipient, photoPath, caption });
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const batchId = `1xauto-shard-${shardNum}-${ts}`;
  const screenshotsDir = path.join(root, 'screenshots', `shard-${shardNum}`);
  const summaryFile = path.join(root, `run-summary-shard-${shardNum}.json`);
  const excelFile = path.join(root, `extracted_numbers-shard-${shardNum}.xlsx`);
  const stateFile = path.join(root, `state-shard-${shardNum}.json`);
  const logFile = path.join(root, 'logs', `shard-${shardNum}-${ts}.log`);
  const seenNumbersFile = path.join(root, 'seen-numbers.json');
  const seenNumbersLock = path.join(root, 'seen-numbers.json.lock');

  mkdirSync(path.join(root, 'logs'), { recursive: true });
  mkdirSync(screenshotsDir, { recursive: true });

  const initialSeen = readSeenNumbers(seenNumbersFile);
  console.log(`[shard ${shardNum}] Starting batch ${batchId}`);
  console.log(`[shard ${shardNum}] Accounts: ${startIndex} -> ${endIndex}`);
  console.log(`[shard ${shardNum}] Loaded ${initialSeen.size} seen numbers from ${seenNumbersFile}`);
  console.log(`[shard ${shardNum}] Telegram recipients: ${recipients.join(', ')}`);

  const env = {
    ...process.env,
    ALLOW_LIVE_RUN: 'true',
    HEADLESS: 'true',
    BATCH_ID: batchId,
    ...(process.env.START_INDEX ? { START_INDEX: process.env.START_INDEX } : {}),
    END_INDEX: String(endIndex),
    STATE_FILE: stateFile,
    RUN_SUMMARY_FILE: summaryFile,
    SCREENSHOTS_DIR: screenshotsDir,
    EXCEL_FILE: excelFile,
    SEEN_NUMBERS_FILE: seenNumbersFile,
    SEEN_NUMBERS_LOCK: seenNumbersLock
  };

  console.log(`[shard ${shardNum}] Spawning Playwright...`);

  const child = spawn('npx', ['playwright', 'test', 'tests/login.spec.js'], {
    cwd: root,
    env,
    shell: process.platform === 'win32'
  });

  const logStream = [];
  let stdoutBuffer = '';

  child.stdout.on('data', async (chunk) => {
    const text = chunk.toString('utf8');
    process.stdout.write(text);
    logStream.push(text);

    stdoutBuffer += text;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // keep trailing partial line

    for (const line of lines) {
      const match = line.match(/screenshot saved\s+([^\r\n]+)/);
      if (match) {
        const rawPath = match[1].trim();
        const photoPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
        if (!existsSync(photoPath)) continue;

        const number = extractNumberFromScreenshotName(path.basename(photoPath));
        if (!number) {
          console.log(`[realtime] No phone number extracted from filename: ${path.basename(photoPath)}`);
          continue;
        }

        // Filter against seen-numbers
        try {
          const newlyClaimed = await claimNewNumbers({
            filePath: seenNumbersFile,
            lockPath: seenNumbersLock,
            numbers: [number]
          });

          if (newlyClaimed.length === 0) {
            console.log(`[dedup] ${number} is already in seen-numbers.json -> SKIPPED (not sent to Telegram)`);
            continue;
          }

          console.log(`[realtime] ${number} is NEW! Sending screenshot photo to Telegram...`);
          // Caption must be the number only!
          const caption = number;

          try {
            await broadcastPhoto(photoPath, caption);
            console.log(`[realtime] Photo sent successfully for ${number} (caption="${caption}")`);
          } catch (sendErr) {
            console.error(`[realtime] Failed to send photo for ${number}: ${sendErr.message}`);
            await releaseNumbers({
              filePath: seenNumbersFile,
              lockPath: seenNumbersLock,
              numbers: [number]
            });
          }
        } catch (dedupErr) {
          console.error(`[dedup] Error checking/claiming ${number}: ${dedupErr.message}`);
        }
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    process.stderr.write(text);
    logStream.push(text);
  });

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', (err) => {
      console.error(`[shard ${shardNum}] Process error:`, err);
      resolve(-1);
    });
  });

  writeFileSync(logFile, logStream.join(''), 'utf8');
  console.log(`[shard ${shardNum}] Playwright finished with exit code ${exitCode}. Log saved: ${logFile}`);

  // Generate excel file at the end
  console.log(`[shard ${shardNum}] Generating excel...`);
  try {
    const excelChild = spawn('node', ['scripts/generate-excel.js'], {
      cwd: root,
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit'
    });
    await new Promise((resolve) => excelChild.on('close', resolve));
  } catch (err) {
    console.error(`[shard ${shardNum}] Generate excel error: ${err.message}`);
  }
}

main().catch((err) => {
  console.error('[run-shard-1] Fatal error:', err);
  process.exit(1);
});
