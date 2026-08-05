import { readdirSync, existsSync } from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import dotenv from 'dotenv';
import {
  dedupeScreenshotPaths,
  extractNumberFromScreenshotName,
  sendTelegramDocumentWithRetry,
  sendTelegramPhotoWithRetry
} from '../lib/telegram.js';
import { claimNewNumbers, readSeenNumbers, releaseNumbers } from '../lib/dedup.js';

dotenv.config();

const screenshotsDir = path.resolve(process.cwd(), process.env.SCREENSHOTS_DIR || 'screenshots');
const seenNumbersFile = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json');
const seenNumbersLock = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_LOCK || 'seen-numbers.json.lock');
const combinedExcelPath = path.resolve(process.cwd(), process.env.EXCEL_COMBINED_FILE || 'extracted_numbers-combined.xlsx');
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const channelId = process.env.TELEGRAM_CHANNEL_ID;

if (!botToken || !chatId) {
  console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping.');
  process.exit(0);
}

const recipients = channelId ? [chatId, channelId] : [chatId];

if (!existsSync(screenshotsDir)) {
  console.log(`Screenshots dir missing: ${screenshotsDir}`);
  process.exit(1);
}

const paths = readdirSync(screenshotsDir)
  .filter((name) => /\.(png|jpe?g)$/i.test(name) && extractNumberFromScreenshotName(name))
  .sort()
  .map((name) => path.join(screenshotsDir, name));

console.log(`Scanning ${screenshotsDir}: ${paths.length} screenshot file(s).`);

let newNumbers = [];
try {
  newNumbers = await claimNewNumbers({
    filePath: seenNumbersFile,
    lockPath: seenNumbersLock,
    numbers: paths.map((p) => extractNumberFromScreenshotName(p)).filter(Boolean)
  });
  console.log(`Ledger: ${newNumbers.length} new number(s) to send (${readSeenNumbers(seenNumbersFile).size} unique total).`);
} catch (error) {
  console.error(`Failed to claim numbers from ledger: ${error.message}`);
  process.exit(1);
}

const newNumberSet = new Set(newNumbers);
const toSend = dedupeScreenshotPaths(paths).filter((p) => newNumberSet.has(extractNumberFromScreenshotName(p)));

let failures = 0;
for (const photoPath of toSend) {
  const number = extractNumberFromScreenshotName(path.basename(photoPath));
  const caption = number ? `Number: ${number}` : undefined;
  try {
    for (const recipient of recipients) {
      await sendTelegramPhotoWithRetry({ botToken, chatId: recipient, photoPath, caption });
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log(`Sent screenshot: ${photoPath}${channelId ? ` (chat + channel ${channelId})` : ''}`);
  } catch (error) {
    failures += 1;
    console.error(`Failed to send screenshot ${photoPath}: ${error.message}`);
    try {
      const released = await releaseNumbers({
        filePath: seenNumbersFile,
        lockPath: seenNumbersLock,
        numbers: [number].filter(Boolean)
      });
      if (released > 0) {
        console.log(`Released number ${number} from ledger so it can be retried.`);
      }
    } catch (releaseError) {
      console.error(`Failed to release number ${number}: ${releaseError.message}`);
    }
  }
}

const allNumbers = [...readSeenNumbers(seenNumbersFile)].sort();
if (allNumbers.length > 0) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(allNumbers.map((num) => ({ Phone: num })));
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Numbers');
  XLSX.writeFile(workbook, combinedExcelPath);
  console.log(`Combined excel written: ${combinedExcelPath} (${allNumbers.length} unique numbers).`);

  try {
    for (const recipient of recipients) {
      await sendTelegramDocumentWithRetry({
        botToken,
        chatId: recipient,
        documentPath: combinedExcelPath,
        caption: `Unique numbers (combined across shards): ${allNumbers.length}`
      });
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log(`Sent combined excel to Telegram${channelId ? ` (chat + channel ${channelId})` : ''}.`);
  } catch (error) {
    console.error(`Failed to send combined excel: ${error.message}`);
    process.exit(1);
  }
} else {
  console.log('Ledger empty — skipping excel.');
}

console.log(`Force-send done. Sent ${toSend.length - failures}/${toSend.length} screenshot(s), ${failures} failure(s).`);
process.exit(failures > 0 ? 1 : 0);
