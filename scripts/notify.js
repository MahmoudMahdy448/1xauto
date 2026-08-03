import { existsSync, readFileSync } from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import dotenv from 'dotenv';
import {
  buildTelegramMessage,
  dedupeScreenshotPaths,
  extractNumberFromScreenshotName,
  sendTelegramDocument,
  sendTelegramMessage,
  sendTelegramPhoto
} from '../lib/telegram.js';
import { claimNewNumbers, readSeenNumbers } from '../lib/dedup.js';

dotenv.config();

const summaryPath = path.resolve(process.cwd(), process.env.RUN_SUMMARY_FILE || 'run-summary.json');
const screenshotsDir = path.resolve(process.cwd(), process.env.SCREENSHOTS_DIR || 'screenshots');
const seenNumbersFile = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json');
const seenNumbersLock = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_LOCK || 'seen-numbers.json.lock');
const combinedExcelPath = path.resolve(process.cwd(), process.env.EXCEL_COMBINED_FILE || 'extracted_numbers-combined.xlsx');
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const channelId = process.env.TELEGRAM_CHANNEL_ID;

if (!botToken || !chatId) {
  console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping notification.');
  process.exit(0);
}

const recipients = channelId ? [chatId, channelId] : [chatId];

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

// Claim only numbers that have never been sent before (across shards and loops).
let newNumbers = [];
try {
  newNumbers = await claimNewNumbers({
    filePath: seenNumbersFile,
    lockPath: seenNumbersLock,
    numbers: deduped.map((p) => extractNumberFromScreenshotName(p)).filter(Boolean)
  });
  console.log(`Ledger: ${newNumbers.length} new number(s) to send (${readSeenNumbers(seenNumbersFile).size} unique total).`);
} catch (error) {
  console.error(`Failed to claim numbers from ledger: ${error.message}`);
  process.exit(1);
}

const newNumberSet = new Set(newNumbers);
const toSend = deduped.filter((p) => newNumberSet.has(extractNumberFromScreenshotName(p)));

if (toSend.length === 0) {
  console.log('No new screenshots to send (all numbers already reported).');
} else {
  let failures = 0;
  for (const relativePath of toSend) {
    const photoPath = path.isAbsolute(relativePath)
      ? relativePath
      : path.resolve(screenshotsDir, path.basename(relativePath));
    if (!existsSync(photoPath)) {
      console.log(`Screenshot missing, skipping: ${photoPath}`);
      continue;
    }
    const number = extractNumberFromScreenshotName(path.basename(photoPath));
    const caption = number ? `Number: ${number}` : undefined;
    try {
      for (const recipient of recipients) {
        await sendTelegramPhoto({ botToken, chatId: recipient, photoPath, caption });
      }
      console.log(`Sent screenshot: ${photoPath}${channelId ? ` (chat + channel ${channelId})` : ''}`);
    } catch (error) {
      failures += 1;
      console.error(`Failed to send screenshot ${photoPath}: ${error.message}`);
    }
  }

  if (failures > 0) {
    process.exit(1);
  }
}

// Send the combined deduped excel (all unique numbers seen across shards/loops).
const allNumbers = [...readSeenNumbers(seenNumbersFile)].sort();
if (allNumbers.length === 0) {
  console.log('Ledger empty — skipping excel.');
  process.exit(0);
}

const workbook = XLSX.utils.book_new();
const worksheet = XLSX.utils.json_to_sheet(allNumbers.map((num) => ({ Phone: num })));
XLSX.utils.book_append_sheet(workbook, worksheet, 'Numbers');
XLSX.writeFile(workbook, combinedExcelPath);
console.log(`Combined excel written: ${combinedExcelPath} (${allNumbers.length} unique numbers).`);

try {
  for (const recipient of recipients) {
    await sendTelegramDocument({
      botToken,
      chatId: recipient,
      documentPath: combinedExcelPath,
      caption: `Unique numbers (combined across shards): ${allNumbers.length}`
    });
  }
  console.log(`Sent combined excel to Telegram${channelId ? ` (chat + channel ${channelId})` : ''}.`);
} catch (error) {
  console.error(`Failed to send combined excel: ${error.message}`);
  process.exit(1);
}

process.exit(0);
