import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  sendPhotoToRecipients,
  extractNumberFromScreenshotName,
} from '../lib/telegram.js';
import { claimNewNumbers, releaseNumbers } from '../lib/dedup.js';
import { emit } from '../lib/events.js';
import { pruneSentScreenshots, screenshotRetentionMs } from '../lib/screenshot-retention.js';

dotenv.config();

const screenshotsDir = path.resolve(process.cwd(), process.env.SCREENSHOTS_DIR || 'screenshots');
const seenNumbersFile = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json');
const seenNumbersLock = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_LOCK || 'seen-numbers.json.lock');
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
// "off" disables the channel copy without unsetting the variable (PowerShell
// cannot set an env var to an empty string, and dotenv would reload it).
const channelId = process.env.TELEGRAM_CHANNEL_ID === 'off' ? null : process.env.TELEGRAM_CHANNEL_ID;
const pollMs = parseInt(process.env.REALTIME_POLL_MS, 10) || 5000;
// Delete screenshots that are already delivered (number in the ledger) once
// they are old enough. 0 / SCREENSHOT_RETENTION=off keeps every file.
const retentionMs = screenshotRetentionMs();

if (!botToken || !chatId) {
  console.log('[realtime-send] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — exiting.');
  process.exit(0);
}

const recipients = channelId ? [chatId, channelId] : [chatId];

// Only send screenshots created AFTER this process started.
// Prevents resending old screenshots from previous batches.
const startTimeMs = Date.now();

const sent = new Set();
let isSending = false;

function isFileStable(filePath) {
  try {
    const s = statSync(filePath);
    return s.size > 0 && Date.now() - s.mtimeMs > 2000;
  } catch {
    return false;
  }
}

// Runs after every scan, including the ones with nothing to send. Files the
// sender will never look at again (old, already in the ledger) are the ones
// retention removes; see lib/screenshot-retention.js for the safety rules.
function pruneSentFiles() {
  if (retentionMs <= 0) return;
  try {
    const result = pruneSentScreenshots({ screenshotsDir, seenNumbersFile, retentionMs });
    if (result.deleted.length === 0) return;

    const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(1);
    emit({
      kind: 'screenshot.pruned',
      data: {
        count: result.deleted.length,
        freedBytes: result.freedBytes,
        keptUnsent: result.keptUnsent,
        keptYoung: result.keptYoung
      }
    });
    console.log(
      `[realtime-send] Retention: deleted ${result.deleted.length} already-sent screenshot(s), freed ${freedMb} MB`
    );
  } catch (err) {
    console.error(`[realtime-send] Retention sweep failed: ${err.message}`);
  }
}

function isNewFile(filePath) {
  try {
    return statSync(filePath).mtimeMs >= startTimeMs;
  } catch {
    return false;
  }
}

// One file per phone number: Telegram must never get the same number twice in a
// run, even when Playwright writes "number.png" and "number(2).png".
function collectPendingFiles() {
  if (!existsSync(screenshotsDir)) return [];

  const byNumber = new Map();
  for (const f of readdirSync(screenshotsDir).filter((n) => /\.(png|jpe?g)$/i.test(n)).sort()) {
    const number = extractNumberFromScreenshotName(f);
    if (!number) continue;
    if (sent.has(number) || byNumber.has(number)) continue;

    const fullPath = path.join(screenshotsDir, f);
    if (!isNewFile(fullPath) || !isFileStable(fullPath)) continue;
    byNumber.set(number, fullPath);
  }
  return [...byNumber.entries()];
}

async function sendPhoto(photoPath, number) {
  const result = await sendPhotoToRecipients({ botToken, recipients, photoPath, caption: number });
  await new Promise((r) => setTimeout(r, 1500));
  if (result.failed.length > 0 && result.ok.length > 0) {
    emit({
      kind: 'send.failed',
      data: {
        number,
        error: result.failed.map((item) => `${item.chatId}: ${item.error}`).join(' | ')
      }
    });
  }
  if (result.ok.length === 0) {
    throw new Error(result.failed[0]?.error || 'no recipient accepted the photo');
  }
  return result;
}

async function scanAndSend() {
  if (isSending) return;
  isSending = true;

  try {
    const pending = collectPendingFiles();
    if (pending.length === 0) return;

    for (const [number, photoPath] of pending) {
      // Claim right before sending. A claim that is never sent (crash, kill)
      // costs at most this one number instead of the whole pending batch.
      let claimed;
      try {
        claimed = await claimNewNumbers({
          filePath: seenNumbersFile,
          lockPath: seenNumbersLock,
          numbers: [number],
        });
      } catch (err) {
        console.error(`[realtime-send] Ledger claim failed: ${err.message}`);
        emit({ kind: 'ledger.claim_failed', data: { number, error: err.message } });
        continue;
      }

      if (claimed.length === 0) {
        sent.add(number);
        emit({ kind: 'send.skip', data: { number, reason: 'already-seen' } });
        console.log(`[realtime-send] SKIP (already seen): ${number}`);
        continue;
      }

      try {
        const result = await sendPhoto(photoPath, number);
        sent.add(number);
        emit({
          kind: 'send.ok',
          data: {
            number,
            recipients: result.ok.length,
            failed: result.failed.length
          }
        });
        console.log(`[realtime-send] SENT: ${path.basename(photoPath)} (${number})`);
      } catch (err) {
        console.error(`[realtime-send] Failed to send ${photoPath}: ${err.message}`);
        emit({ kind: 'send.failed', data: { number, error: err.message } });
        try {
          await releaseNumbers({ filePath: seenNumbersFile, lockPath: seenNumbersLock, numbers: [number] });
          console.log(`[realtime-send] Released ${number} for retry`);
        } catch (releaseErr) {
          console.error(`[realtime-send] Release failed for ${number}: ${releaseErr.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[realtime-send] Scan error: ${err.message}`);
  } finally {
    pruneSentFiles();
    isSending = false;
  }
}

console.log(`[realtime-send] Watching ${screenshotsDir} for NEW screenshots (started at ${new Date().toISOString()})`);
console.log(`[realtime-send] Ledger: ${seenNumbersFile}`);
console.log(
  retentionMs > 0
    ? `[realtime-send] Retention: delete sent screenshots older than ${Math.round(retentionMs / 60000)} min`
    : '[realtime-send] Retention: off (screenshots are kept)'
);

await scanAndSend();

const timer = setInterval(scanAndSend, pollMs);

function shutdown() {
  clearInterval(timer);
  emit({ kind: 'sender.stopped', data: { component: 'realtime-send' } });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Never outlive the batch that started us. On Windows a killed shell wrapper
// used to leave this process orphaned, still watching and still sending.
const parentPid = process.ppid;
const parentCheck = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    console.error('[realtime-send] Parent process is gone — exiting.');
    clearInterval(parentCheck);
    shutdown();
  }
}, 30000);
