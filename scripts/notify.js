import { existsSync, readFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { buildTelegramMessage, sendTelegramMessage } from '../lib/telegram.js';

dotenv.config();

const summaryPath = path.resolve(process.cwd(), 'run-summary.json');
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
