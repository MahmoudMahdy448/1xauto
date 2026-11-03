// site-block-notify.js
// Admin-only messages for the IP-block circuit breaker.
//
// The channel never sees these: an IP block is an operations problem, not a
// number. A Telegram failure must never stop a pass or the breaker itself.

import { existsSync } from 'fs';
import { sendTelegramMessage, sendTelegramPhotoWithRetry } from './telegram.js';
import { buildSiteBlockText, buildSiteUnblockedText } from './site-block.js';

function config() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    adminChatId: process.env.TELEGRAM_CHAT_ID
  };
}

async function sendText({ botToken, chatId, text }) {
  try {
    await sendTelegramMessage({ botToken, chatId, text });
    return true;
  } catch (error) {
    console.error(`[block] text to ${chatId} failed: ${error.message}`);
    return false;
  }
}

async function sendPhoto({ botToken, chatId, photoPath, caption }) {
  try {
    await sendTelegramPhotoWithRetry({ botToken, chatId, photoPath, caption });
    return true;
  } catch (error) {
    console.error(`[block] photo to ${chatId} failed: ${error.message}`);
    return false;
  }
}

// Returns { ok, failed } without throwing.
export async function sendSiteBlockAlert({ block, images = [] } = {}) {
  const { botToken, adminChatId } = config();
  if (!botToken || !adminChatId) {
    console.error('[block] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing — alert not sent');
    return { ok: [], failed: [{ chatId: null, error: 'telegram not configured' }] };
  }

  const ok = [];
  const failed = [];
  const files = (images || []).filter((file) => file && existsSync(file));

  if (files.length) {
    const sent = await sendPhoto({ botToken, chatId: adminChatId, photoPath: files[0] });
    (sent ? ok : failed).push(adminChatId);
  }

  const textSent = await sendText({
    botToken,
    chatId: adminChatId,
    text: buildSiteBlockText(block)
  });
  (textSent ? ok : failed).push(adminChatId);

  return { ok, failed };
}

export async function sendSiteUnblockedAlert({ block } = {}) {
  const { botToken, adminChatId } = config();
  if (!botToken || !adminChatId) return { ok: [], failed: [{ chatId: null, error: 'telegram not configured' }] };

  const sent = await sendText({
    botToken,
    chatId: adminChatId,
    text: buildSiteUnblockedText(block)
  });
  return { ok: sent ? [adminChatId] : [], failed: sent ? [] : [adminChatId] };
}
