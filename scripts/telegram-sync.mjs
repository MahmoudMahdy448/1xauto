// Rebuilds seen-numbers.json from the Telegram channel history, using the
// logged-in user session from scripts/telegram-login.mjs.
//
//   node scripts/telegram-sync.mjs
//
// Only numbers that really exist as channel messages count as delivered.
// A ledger entry that is missing from the channel is dropped only after it is
// missing on two consecutive syncs, so an in-flight send is never re-sent.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { withSeenNumbersLock } from '../lib/dedup.js';
import { emit } from '../lib/events.js';

dotenv.config();

const PHONE_RE = /01\d{9}/g;
const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;
const channelRef = process.env.TELEGRAM_CHANNEL_ID || '-1004357023695';
const sessionPath = path.resolve(process.cwd(), process.env.TELEGRAM_SESSION_FILE || 'telegram-session.txt');
const ledgerPath = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json');
const lockPath = process.env.SEEN_NUMBERS_LOCK || `${ledgerPath}.lock`;
const statePath = path.join(path.dirname(ledgerPath), 'telegram-sync-state.json');

if (!apiId || !apiHash) {
  console.error('[telegram-sync] TELEGRAM_API_ID / TELEGRAM_API_HASH missing in .env — run scripts/telegram-login.mjs first.');
  process.exit(1);
}
if (!existsSync(sessionPath)) {
  console.error('[telegram-sync] No session file — run "node scripts/telegram-login.mjs" once.');
  process.exit(1);
}

async function resolveChannel(client) {
  try {
    return await client.getEntity(channelRef);
  } catch {
    // Private channel: find it from the account's dialogs.
    const targetId = String(channelRef).replace(/^-100/, '');
    for await (const dialog of client.iterDialogs({})) {
      const entity = dialog.entity;
      if (entity && String(entity.id) === targetId) return entity;
    }
  }
  throw new Error(`Channel ${channelRef} not found in this account's dialogs.`);
}

function numbersFromText(text) {
  return text ? text.match(PHONE_RE) || [] : [];
}

const client = new TelegramClient(
  new StringSession(readFileSync(sessionPath, 'utf8').trim()),
  apiId,
  apiHash,
  { connectionRetries: 5 }
);

const startedAt = Date.now();
emit({ kind: 'sync.start' });

try {

let delivered = new Set();
let messageCount = 0;

try {
  await client.connect();
  const channel = await resolveChannel(client);

  for await (const message of client.iterMessages(channel, { limit: undefined })) {
    messageCount += 1;
    for (const n of numbersFromText(message.text)) delivered.add(n);
  }
} finally {
  await client.disconnect();
}

let previous = new Set();
let previousMissing = new Set();
if (existsSync(ledgerPath)) {
  try {
    previous = new Set(JSON.parse(readFileSync(ledgerPath, 'utf8').replace(/^\uFEFF/, '')).numbers || []);
  } catch {
    previous = new Set();
  }
}
if (existsSync(statePath)) {
  try {
    previousMissing = new Set(JSON.parse(readFileSync(statePath, 'utf8')).missing || []);
  } catch {
    previousMissing = new Set();
  }
}

const missingNow = [...previous].filter((n) => !delivered.has(n));
const dropped = missingNow.filter((n) => previousMissing.has(n));
const stillMissing = missingNow.filter((n) => !previousMissing.has(n));

let newSize = 0;

await withSeenNumbersLock(lockPath, () => {
  const kept = [...previous].filter((n) => !dropped.includes(n));
  const merged = new Set([...kept, ...delivered]);
  newSize = merged.size;
  writeFileSync(
    ledgerPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), numbers: [...merged].sort() }, null, 2)
  );
  writeFileSync(
    statePath,
    JSON.stringify({ updatedAt: new Date().toISOString(), missing: stillMissing.sort() }, null, 2)
  );
});

console.log(
  `[telegram-sync] ${new Date().toISOString()} messages=${messageCount} delivered=${delivered.size} ` +
    `ledger=${newSize} dropped=${dropped.length} pendingDrop=${stillMissing.length}`
);
if (dropped.length > 0) {
  console.log(`[telegram-sync] released (confirmed never delivered): ${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ' ...' : ''}`);
}

emit({
  kind: 'sync.done',
  data: {
    messages: messageCount,
    delivered: delivered.size,
    ledger: newSize,
    dropped: dropped.length,
    pending: stillMissing.length,
    durationMs: Date.now() - startedAt
  }
});

} catch (error) {
  console.error(`[telegram-sync] failed: ${error.message}`);
  emit({ kind: 'sync.failed', data: { error: error.message, durationMs: Date.now() - startedAt } });
  process.exit(1);
}
