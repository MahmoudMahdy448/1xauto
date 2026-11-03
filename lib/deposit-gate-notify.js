// deposit-gate-notify.js
// Sends the gate alerts to the admin chat and the public channel.
//
// Rules that matter here:
//   - monitoring text goes to the admin chat only;
//   - the channel gets the screenshot with a short caption;
//   - a Telegram failure must never fail an account or clear a gate.

import { existsSync } from 'fs';
import {
  sendTelegramMessage,
  sendTelegramPhotoWithRetry
} from './telegram.js';
import {
  buildAlertText,
  buildProbeBrokenText,
  buildStillDownText,
  channelCaption
} from './deposit-gate.js';

const SEND_GAP_MS = 1200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function config() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    adminChatId: process.env.TELEGRAM_CHAT_ID,
    channelId: process.env.TELEGRAM_CHANNEL_ID
  };
}

async function sendText({ botToken, chatId, text }) {
  try {
    await sendTelegramMessage({ botToken, chatId, text });
    return true;
  } catch (error) {
    console.error(`[gate] text to ${chatId} failed: ${error.message}`);
    return false;
  }
}

async function sendPhoto({ botToken, chatId, photoPath, caption }) {
  try {
    await sendTelegramPhotoWithRetry({ botToken, chatId, photoPath, caption });
    return true;
  } catch (error) {
    console.error(`[gate] photo to ${chatId} failed: ${error.message}`);
    return false;
  }
}

// Returns { ok, failed } without throwing.
export async function sendGateAlert({ kind, gate, images = [], extraText } = {}) {
  const { botToken, adminChatId, channelId } = config();
  if (!botToken || !adminChatId) {
    console.error('[gate] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing — alert not sent');
    return { ok: [], failed: [{ chatId: null, error: 'telegram not configured' }] };
  }

  const ok = [];
  const failed = [];
  const files = (images || []).filter((p) => p && existsSync(p));

  // Operator messages: admin chat only, no screenshot, no channel copy.
  // `still-down` is the per-probe heartbeat; `probe-broken` is a real fault.
  if (kind === 'probe-broken' || kind === 'still-down') {
    const text =
      extraText ||
      (kind === 'probe-broken' ? buildProbeBrokenText(gate) : buildStillDownText(gate));
    const sent = await sendText({ botToken, chatId: adminChatId, text });
    (sent ? ok : failed).push(adminChatId);
    return { ok, failed };
  }

  const text = buildAlertText(kind, gate);
  const caption = channelCaption(kind, gate);

  // Admin: the full explanation plus every image.
  for (let i = 0; i < files.length; i += 1) {
    const sent = await sendPhoto({
      botToken,
      chatId: adminChatId,
      photoPath: files[i],
      caption: i === 0 ? caption : undefined
    });
    (sent ? ok : failed).push(adminChatId);
    await sleep(SEND_GAP_MS);
  }

  const textSent = await sendText({ botToken, chatId: adminChatId, text });
  (textSent ? ok : failed).push(adminChatId);

  // Channel: the same evidence with a short caption. The first alert carries
  // both shots (the greyed grid and the "Information message" box), because
  // the grid alone does not show the reason.
  if (channelId && files.length) {
    for (let i = 0; i < files.length; i += 1) {
      await sleep(SEND_GAP_MS);
      const sent = await sendPhoto({
        botToken,
        chatId: channelId,
        photoPath: files[i],
        caption: i === 0 ? caption : undefined
      });
      (sent ? ok : failed).push(channelId);
    }
  }

  if (failed.length) {
    console.error(`[gate] ${kind} alert partially failed: ${JSON.stringify(failed)}`);
  }

  return { ok, failed };
}
