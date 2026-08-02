import { existsSync, readFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  buildTelegramMessage,
  dedupeScreenshotPaths,
  extractNumberFromScreenshotName,
  sendTelegramMessage,
  sendTelegramPhoto
} from '../lib/telegram.js';

dotenv.config();

const summaryPath = path.resolve(process.cwd(), process.env.RUN_SUMMARY_FILE || 'run-summary.json');
const screenshotsDir = path.resolve(process.cwd(), process.env.SCREENSHOTS_DIR || 'screenshots');
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!botToken || !chatId) {
  console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping notification.');
  process.exit(0);
}

if (!existsSync(summaryPath)) {
  console.error(`run-summary.json not found at ${summaryPath} — nothing to notify.`);
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const text = buildTelegramMessage(summary);

try {
  await sendTelegramMessage({ botToken, chatId, text });
  console.log('Telegram notification sent.');
} catch (error) {
  console.error(`Telegram notification failed: ${error.message}`);
  process.exit(1);
}

const artifactPaths = Array.isArray(summary.artifactNames) ? summary.artifactNames : [];
const deduped = dedupeScreenshotPaths(artifactPaths);

if (deduped.length === 0) {
  console.log('No screenshots to send.');
  process.exit(0);
}

let failures = 0;
for (const relativePath of deduped) {
  const photoPath = path.isAbsolute(relativePath)
    ? relativePath
    : path.resolve(screenshotsDir, path.basename(relativePath));
  if (!existsSync(photoPath)) {
    console.log(`Screenshot missing, skipping: ${photoPath}`);
    continue;
  }
  const number = extractNumberFromScreenshotName(path.basename(photoPath));
  try {
    await sendTelegramPhoto({
      botToken,
      chatId,
      photoPath,
      caption: number ? `Number: ${number}` : undefined
    });
    console.log(`Sent screenshot: ${photoPath}`);
  } catch (error) {
    failures += 1;
    console.error(`Failed to send screenshot ${photoPath}: ${error.message}`);
  }
}

process.exit(failures > 0 ? 1 : 0);
