import { readFileSync } from 'fs';
import path from 'path';

export function buildTelegramMessage(summary) {
  const status = summary.failed > 0 ? '⚠️ partial failures' : 'OK';
  const lines = [
    `Batch ${summary.batchId || 'n/a'} — ${status}`,
    `Success rate: ${(summary.successRate * 100).toFixed(1)}% (${summary.succeeded}/${summary.totalAccounts})`,
    `Processed: ${summary.lastProcessedIndex}/${summary.totalAccounts}`,
    `Unique numbers: ${summary.uniqueNumbers}`,
    `Screenshots: ${summary.screenshotsRetained}`,
    `Duration: ${Math.round(summary.durationMs / 1000)}s`
  ];

  if (summary.retryCount > 0) {
    lines.push(`Retries: ${summary.retryCount}`);
  }

  return lines.join('\n');
}

export function buildTelegramUrl(botToken) {
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

export function buildTelegramPhotoUrl(botToken) {
  return `https://api.telegram.org/bot${botToken}/sendPhoto`;
}

export async function sendTelegramMessage({ botToken, chatId, text }) {
  const response = await fetch(buildTelegramUrl(botToken), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${body}`);
  }

  return response.json();
}

export async function sendTelegramPhoto({ botToken, chatId, photoPath, caption }) {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('photo', new Blob([readFileSync(photoPath)]), path.basename(photoPath));
  if (caption) {
    form.append('caption', caption);
  }

  const response = await fetch(buildTelegramPhotoUrl(botToken), {
    method: 'POST',
    body: form
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${body}`);
  }

  return response.json();
}

const PHONE_IN_FILENAME_RE = /(01\d{9})/;

export function extractNumberFromScreenshotName(fileName) {
  const match = fileName.match(PHONE_IN_FILENAME_RE);
  return match ? match[1] : null;
}

export function dedupeScreenshotPaths(screenshotPaths) {
  const seen = new Set();
  const deduped = [];
  for (const p of screenshotPaths) {
    const number = extractNumberFromScreenshotName(p);
    if (!number || seen.has(number)) {
      continue;
    }
    seen.add(number);
    deduped.push(p);
  }
  return deduped;
}
