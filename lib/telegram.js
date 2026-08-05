import { readFileSync } from 'fs';
import path from 'path';

export function buildTelegramMessage(summary) {
  const status = summary.failed > 0 ? '⚠️ partial failures' : 'OK';

  const processed = summary.totalAccounts
    ? summary.totalAccounts
    : summary.succeeded + summary.failed;
  const shardProcessed =
    typeof summary.lastProcessedIndex === 'number' && typeof summary.startIndex === 'number'
      ? summary.lastProcessedIndex - summary.startIndex + 1
      : processed;
  const rate = shardProcessed > 0 ? (summary.succeeded / shardProcessed) * 100 : 0;

  const lines = [
    `Batch ${summary.batchId || 'n/a'} — ${status}`,
    `Success rate: ${rate.toFixed(1)}% (${summary.succeeded}/${shardProcessed} processed)`,
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

export function buildTelegramUpdatesUrl(botToken) {
  return `https://api.telegram.org/bot${botToken}/getUpdates`;
}

export async function getTelegramUpdates({ botToken, offset, timeoutSeconds = 30 }) {
  const response = await fetch(
    `${buildTelegramUpdatesUrl(botToken)}?timeout=${timeoutSeconds}&offset=${offset ?? 0}`,
    { method: 'GET' }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram getUpdates error: ${JSON.stringify(data)}`);
  }
  return data.result || [];
}

export function buildTelegramPhotoUrl(botToken) {
  return `https://api.telegram.org/bot${botToken}/sendPhoto`;
}

export function buildTelegramDocumentUrl(botToken) {
  return `https://api.telegram.org/bot${botToken}/sendDocument`;
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

  if (response.status === 429) {
    let retryAfter = 30;
    try {
      const body = await response.json();
      retryAfter = body?.parameters?.retry_after || 30;
    } catch {
      // keep default
    }
    throw new TelegramRateLimitError(retryAfter);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${body}`);
  }

  return response.json();
}

export class TelegramRateLimitError extends Error {
  constructor(retryAfter) {
    super(`Telegram rate limited — retry after ${retryAfter}s`);
    this.name = 'TelegramRateLimitError';
    this.retryAfter = retryAfter;
  }
}

async function withRateLimitRetry(send, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof TelegramRateLimitError) || attempt === maxRetries) {
        throw error;
      }
      const waitMs = (error.retryAfter + 1) * 1000;
      console.log(`Rate limited — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return undefined;
}

export function sendTelegramPhotoWithRetry({ botToken, chatId, photoPath, caption }) {
  return withRateLimitRetry(() => sendTelegramPhoto({ botToken, chatId, photoPath, caption }));
}

export async function sendTelegramDocument({ botToken, chatId, documentPath, caption }) {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', new Blob([readFileSync(documentPath)]), path.basename(documentPath));
  if (caption) {
    form.append('caption', caption);
  }

  const response = await fetch(buildTelegramDocumentUrl(botToken), {
    method: 'POST',
    body: form
  });

  if (response.status === 429) {
    let retryAfter = 30;
    try {
      const body = await response.json();
      retryAfter = body?.parameters?.retry_after || 30;
    } catch {
      // keep default
    }
    throw new TelegramRateLimitError(retryAfter);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${body}`);
  }

  return response.json();
}

export function sendTelegramDocumentWithRetry({ botToken, chatId, documentPath, caption }) {
  return withRateLimitRetry(() => sendTelegramDocument({ botToken, chatId, documentPath, caption }));
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
