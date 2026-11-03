// One-time Telegram login for the ledger sync.
//
// Interactive:   node scripts/telegram-login.mjs
// Automated:     node scripts/telegram-login.mjs --auto
//                (uses TELEGRAM_PHONE from .env, reads the login code from
//                 telegram-login-code.txt and, if needed, the 2FA password
//                 from telegram-login-password.txt)
//
// Requires TELEGRAM_API_ID and TELEGRAM_API_HASH in .env.
// Saves telegram-session.txt, which scripts/telegram-sync.mjs reuses.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { createInterface } from 'readline/promises';
import dotenv from 'dotenv';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

dotenv.config();

const auto = process.argv.includes('--auto');
const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionPath = path.resolve(process.cwd(), process.env.TELEGRAM_SESSION_FILE || 'telegram-session.txt');
const codePath = path.resolve(process.cwd(), 'telegram-login-code.txt');
const passwordPath = path.resolve(process.cwd(), 'telegram-login-password.txt');
const codeTimeoutMs = 10 * 60 * 1000;

if (!apiId || !apiHash) {
  console.error('Missing TELEGRAM_API_ID / TELEGRAM_API_HASH in .env.');
  process.exit(1);
}
if (auto && !process.env.TELEGRAM_PHONE) {
  console.error('Missing TELEGRAM_PHONE in .env (needed for --auto).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForValue(file, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  console.log(`Waiting for ${label} in ${path.basename(file)} ...`);
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const value = readFileSync(file, 'utf8').trim();
      if (value) {
        rmSync(file, { force: true });
        return value;
      }
    }
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${label} (${path.basename(file)}).`);
}

const existing = existsSync(sessionPath) ? readFileSync(sessionPath, 'utf8').trim() : '';
const client = new TelegramClient(new StringSession(existing), apiId, apiHash, { connectionRetries: 5 });
const rl = auto ? null : createInterface({ input: process.stdin, output: process.stdout });

try {
  await client.start({
    phoneNumber: async () =>
      auto ? process.env.TELEGRAM_PHONE : rl.question('Phone number (international, e.g. +201234567890): '),
    phoneCode: async () =>
      auto
        ? waitForValue(codePath, 'login code', codeTimeoutMs)
        : rl.question('Login code from Telegram: '),
    password: async () => {
      if (process.env.TELEGRAM_2FA_PASSWORD) return process.env.TELEGRAM_2FA_PASSWORD;
      return auto
        ? waitForValue(passwordPath, '2FA password', 5 * 60 * 1000)
        : rl.question('Two-step password (empty if none): ');
    },
    onError: (error) => {
      console.error(`Login error: ${error.message}`);
      return true;
    },
  });

  const me = await client.getMe();
  writeFileSync(sessionPath, client.session.save());
  console.log(`Logged in as ${me.firstName || ''} ${me.username ? `(@${me.username})` : ''}`.trim());
  console.log(`Session saved to ${sessionPath}`);
} catch (error) {
  console.error(`Login failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rl?.close();
  await client.disconnect();
}
