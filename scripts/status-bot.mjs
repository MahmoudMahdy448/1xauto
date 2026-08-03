import dotenv from 'dotenv';
import { buildStatusText } from '../lib/status.js';
import { getTelegramUpdates, sendTelegramMessage } from '../lib/telegram.js';

dotenv.config();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const passcode = process.env.STATUS_PASSCODE || '';
const allowedIds = new Set(
  (process.env.STATUS_ALLOWED_IDS || process.env.TELEGRAM_CHAT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

if (!botToken) {
  console.error('TELEGRAM_BOT_TOKEN not set — status bot cannot start.');
  process.exit(1);
}

console.log(
  `Status bot started. Authorized chats: ${[...allowedIds].join(', ') || 'NONE'}` +
    (passcode ? ' (passcode required)' : '')
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleUpdate(update) {
  const msg = update.message || update.channel_post || update.edited_message;
  if (!msg || typeof msg.text !== 'string' || !msg.text.startsWith('/')) {
    return;
  }

  const chatId = String(msg.chat?.id ?? '');
  if (!allowedIds.has(chatId)) {
    console.log(`Ignoring command from unauthorized chat ${chatId}`);
    return;
  }

  const text = msg.text.trim();
  console.log(`Handling "${text}" from chat ${chatId}`);

  if (text === '/status') {
    if (passcode && text !== `/status ${passcode}`) {
      await sendTelegramMessage({
        botToken,
        chatId,
        text: 'Access denied. Send `/status <passcode>`.'
      });
      return;
    }
    const status = buildStatusText({ appDir: process.cwd() });
    try {
      await sendTelegramMessage({ botToken, chatId, text: status });
    } catch (error) {
      console.error(`Failed to send status: ${error.message}`);
    }
  } else if (text === '/help') {
    await sendTelegramMessage({
      botToken,
      chatId,
      text: `Commands:\n/status${passcode ? ' <passcode>' : ''} — VM health snapshot\n/help — this message`
    });
  }
}

let offset = 0;
while (true) {
  try {
    const updates = await getTelegramUpdates({ botToken, offset, timeoutSeconds: 30 });
    for (const update of updates) {
      offset = update.update_id + 1;
      await handleUpdate(update);
    }
  } catch (error) {
    console.error(`getUpdates error (retrying in 5s): ${error.message}`);
    await sleep(5000);
  }
}
