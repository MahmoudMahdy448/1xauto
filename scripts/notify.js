import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  buildTelegramMessage,
  dedupeScreenshotPaths,
  extractNumberFromScreenshotName,
  sendTelegramMessage,
  sendTelegramPhotoWithRetry
} from '../lib/telegram.js';
import { claimNewNumbers, readSeenNumbers, releaseNumbers } from '../lib/dedup.js';

dotenv.config();

const summaryPath = path.resolve(process.cwd(), process.env.RUN_SUMMARY_FILE || 'run-summary.json');
const screenshotsDir = path.resolve(process.cwd(), process.env.SCREENSHOTS_DIR || 'screenshots');
// Combined mode: SCREENSHOTS_DIRS="dir1,dir2,..." scans multiple shard dirs at once.
// Used by the collector service so one notification covers every shard's run.
const screenshotsDirs = (process.env.SCREENSHOTS_DIRS || '')
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => path.resolve(process.cwd(), d));
const seenNumbersFile = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json');
const seenNumbersLock = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_LOCK || 'seen-numbers.json.lock');
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const channelId = process.env.TELEGRAM_CHANNEL_ID === 'off' ? null : process.env.TELEGRAM_CHANNEL_ID;
const runStartedAt = parseInt(process.env.RUN_STARTED_AT, 10) || null;

if (!botToken || !chatId) {
  console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping notification.');
  process.exit(0);
}

const recipients = channelId ? [chatId, channelId] : [chatId];
// The channel is for screenshots only. Batch text summaries are operational
// reporting and stay in the admin chat.
const summaryRecipients = [chatId];

// Build the list of candidate screenshot paths. Prefer run-summary.json (1xauto),
// otherwise scan the screenshots dir (linebet/melbet which don't write summaries).
// In combined mode (SCREENSHOTS_DIRS) scan every shard dir.
// When a run is active, restrict the scan to screenshots created after the run started
// so the "unique-only" excel reflects the current batch.
function scanDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.(png|jpe?g)$/i.test(name) && extractNumberFromScreenshotName(name))
    .sort()
    .map((name) => path.join(dir, name));
}

function listCandidateScreenshots() {
  if (screenshotsDirs.length > 0) {
    let paths = [];
    for (const dir of screenshotsDirs) {
      paths = paths.concat(scanDir(dir));
    }
    if (runStartedAt) {
      paths = paths.filter((p) => {
        try {
          return statSync(p).mtimeMs >= runStartedAt;
        } catch {
          return false;
        }
      });
    }
    return { summary: null, paths };
  }

  if (existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    return { summary, paths: Array.isArray(summary.artifactNames) ? summary.artifactNames : [] };
  }

  return { summary: null, paths: scanDir(screenshotsDir) };
}

const { summary, paths: artifactPaths } = listCandidateScreenshots();

if (!summary && artifactPaths.length === 0) {
  console.log('No screenshots and no summary — nothing to notify.');
  process.exit(0);
}

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

if (summary) {
  const text = buildTelegramMessage(summary);
  try {
    for (const recipient of summaryRecipients) {
      await sendTelegramMessage({ botToken, chatId: recipient, text });
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`Telegram summary sent to ${summaryRecipients.join(', ')}.`);
  } catch (error) {
    console.error(`Telegram summary notification failed: ${error.message}`);
  }
}

if (newNumbers.length === 0) {
  console.log('No new unique numbers — photos skipped.');
  process.exit(0);
}

const newNumberSet = new Set(newNumbers);
const toSend = deduped.filter((p) => newNumberSet.has(extractNumberFromScreenshotName(p)));
console.log(`Sending ${toSend.length} new screenshot(s) to Telegram.`);

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
  const caption = number || undefined;
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

if (failures > 0) {
  process.exit(1);
}

process.exit(0);
