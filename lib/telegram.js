import { readFileSync } from 'fs';
import net from 'net';
import path from 'path';

// Telegram's DCs are far enough away that a single TCP connect attempt can take
// longer than Node's 250 ms happy-eyeballs window. When the window closes while
// a handshake is still in flight, fetch throws a bare "fetch failed"
// (ETIMEDOUT) even though the network is fine. Give the connect a realistic
// budget, and let an operator tune it without editing code.
const connectAttemptMs = Number(process.env.TELEGRAM_CONNECT_ATTEMPT_MS) || 5000;
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout(connectAttemptMs);
}

// A stalled socket must not hang a sender forever.
const REQUEST_TIMEOUT_MS = Number(process.env.TELEGRAM_REQUEST_TIMEOUT_MS) || 120_000;

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

// Base URL is overridable so the integration tests can point every send at a
// local fake Bot API instead of the real one.
function apiBase() {
  return (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
}

export function buildTelegramUrl(botToken) {
  return `${apiBase()}/bot${botToken}/sendMessage`;
}

export function buildTelegramUpdatesUrl(botToken) {
  return `${apiBase()}/bot${botToken}/getUpdates`;
}

export async function getTelegramUpdates({ botToken, offset, timeoutSeconds = 30 }) {
  const response = await fetch(
    `${buildTelegramUpdatesUrl(botToken)}?timeout=${timeoutSeconds}&offset=${offset ?? 0}`,
    { method: 'GET', signal: AbortSignal.timeout((timeoutSeconds + 15) * 1000) }
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
  return `${apiBase()}/bot${botToken}/sendPhoto`;
}

export function buildTelegramDocumentUrl(botToken) {
  return `${apiBase()}/bot${botToken}/sendDocument`;
}

export async function sendTelegramMessage({ botToken, chatId, text }) {
  const response = await fetch(buildTelegramUrl(botToken), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
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
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
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

// Node hides the real transport reason inside error.cause, so a log line that
// only says "fetch failed" cannot be diagnosed. Surface the code (ETIMEDOUT,
// ECONNRESET, ...) next to the message.
export function describeTelegramError(error) {
  const code = error?.cause?.code || error?.cause?.message || error?.code;
  if (!code || String(error?.message || '').includes(String(code))) return error?.message || String(error);
  return `${error.message} (${code})`;
}

// HTTP-level rejections (400/401/403/404) will fail again on retry; transport
// failures and timeouts are worth another attempt.
export function isRetryableNetworkError(error) {
  if (error instanceof TelegramRateLimitError) return false;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true;
  return /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang up|other side closed|network/i.test(
    describeTelegramError(error)
  );
}

async function withRetry(send, maxRetries = 4) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      lastError = error;
      const rateLimited = error instanceof TelegramRateLimitError;
      if (attempt === maxRetries || (!rateLimited && !isRetryableNetworkError(error))) break;
      // Rate limits ask for a specific wait; transport failures back off quickly.
      const waitMs = rateLimited
        ? (error.retryAfter + 1) * 1000
        : Math.min(15_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 400);
      console.log(
        `Telegram send failed (${describeTelegramError(error)}) — retry ${attempt + 1}/${maxRetries} in ${Math.round(waitMs / 1000)}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

export function sendTelegramPhotoWithRetry({ botToken, chatId, photoPath, caption }) {
  return withRetry(() => sendTelegramPhoto({ botToken, chatId, photoPath, caption }));
}

// Sends one photo to several recipients, retrying each copy on its own.
// A failed channel copy no longer forces the chat copy to be sent twice.
export async function sendPhotoToRecipients({ botToken, recipients, photoPath, caption }) {
  const ok = [];
  const failed = [];
  for (const recipient of recipients) {
    try {
      await sendTelegramPhotoWithRetry({ botToken, chatId: recipient, photoPath, caption });
      ok.push(recipient);
    } catch (error) {
      failed.push({ chatId: recipient, error: describeTelegramError(error) });
    }
  }
  return { ok, failed };
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
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
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
  return withRetry(() => sendTelegramDocument({ botToken, chatId, documentPath, caption }));
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
