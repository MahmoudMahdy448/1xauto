// Rebuilds seen-numbers.json from a Telegram chat export (JSON or HTML) or from
// several export files/folders.
//
//   node scripts/rebuild-ledger-from-export.mjs "C:\...\ChatExport_2026-10-29 (1)"
//   node scripts/rebuild-ledger-from-export.mjs result.json
//   ... add --dry-run to only report what would change
//
// The ledger then contains exactly the phone numbers that were actually
// delivered, plus anything sent during the current run (taken from logs/*.log).
// The old ledger is kept as seen-numbers.backup-<timestamp>.json.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { withSeenNumbersLock } from '../lib/dedup.js';

const PHONE_RE = /01\d{9}/;
const dryRun = process.argv.includes('--dry-run');
const inputs = process.argv.slice(2).filter((a) => a !== '--dry-run');

if (inputs.length === 0) {
  console.error('Usage: node scripts/rebuild-ledger-from-export.mjs <export folder | result.json | messages*.html> [--dry-run]');
  process.exit(1);
}

function partNumber(name) {
  const match = name.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

function resolveInputs(list) {
  const files = [];
  for (const input of list) {
    if (!existsSync(input)) throw new Error(`Missing export path: ${input}`);
    if (statSync(input).isDirectory()) {
      const names = readdirSync(input);
      if (names.includes('result.json')) {
        files.push(path.join(input, 'result.json'));
        continue;
      }
      const html = names
        .filter((n) => /^messages.*\.html$/i.test(n))
        .sort((a, b) => partNumber(a) - partNumber(b));
      if (html.length === 0) throw new Error(`No result.json or messages*.html in ${input}`);
      for (const name of html) files.push(path.join(input, name));
      continue;
    }
    files.push(input);
  }
  return files;
}

function textsOfJsonMessage(message) {
  const out = [];
  const push = (value) => {
    if (typeof value === 'string') {
      out.push(value);
    } else if (Array.isArray(value)) {
      for (const part of value) {
        if (typeof part === 'string') out.push(part);
        else if (part && typeof part.text === 'string') out.push(part.text);
      }
    }
  };
  push(message.text);
  push(message.caption);
  return out;
}

function numbersFromJson(raw) {
  const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const numbers = new Set();

  for (const message of messages) {
    if (message.type && message.type !== 'message') continue;
    for (const text of textsOfJsonMessage(message)) {
      for (const match of text.match(PHONE_RE) || []) numbers.add(match);
    }
  }
  return numbers;
}

function numbersFromHtml(raw) {
  const numbers = new Set();
  // Telegram HTML export puts each message body in <div class="text">...</div>.
  const blocks = raw.match(/<div class="text[^"]*">([\s\S]*?)<\/div>/g) || [];
  for (const block of blocks) {
    const text = block
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    for (const match of text.match(PHONE_RE) || []) numbers.add(match);
  }
  return numbers;
}

function numbersSentThisRun() {
  const logsDir = path.resolve(process.cwd(), 'logs');
  if (!existsSync(logsDir)) return new Set();

  const numbers = new Set();
  for (const name of readdirSync(logsDir).filter((f) => f.endsWith('.log'))) {
    const text = readFileSync(path.join(logsDir, name), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('SENT:') && !line.includes('Sent screenshot')) continue;
      const match = line.match(PHONE_RE);
      if (match) numbers.add(match[0]);
    }
  }
  return numbers;
}

const delivered = new Set();
for (const file of resolveInputs(inputs)) {
  const raw = readFileSync(file, 'utf8');
  const found = file.toLowerCase().endsWith('.json') ? numbersFromJson(raw) : numbersFromHtml(raw);
  console.log(`${path.basename(file)}: ${found.size} delivered number(s)`);
  for (const n of found) delivered.add(n);
}

for (const n of numbersSentThisRun()) delivered.add(n);

const ledgerPath = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json');
const lockPath = process.env.SEEN_NUMBERS_LOCK || `${ledgerPath}.lock`;

let previous = new Set();
if (existsSync(ledgerPath)) {
  try {
    previous = new Set(JSON.parse(readFileSync(ledgerPath, 'utf8').replace(/^\uFEFF/, '')).numbers || []);
  } catch {
    previous = new Set();
  }
}

const added = [...delivered].filter((n) => !previous.has(n));
const dropped = [...previous].filter((n) => !delivered.has(n));

console.log(`\nDelivered numbers found : ${delivered.size}`);
console.log(`Current ledger         : ${previous.size}`);
console.log(`Would keep (in export) : ${delivered.size - added.length}`);
console.log(`Would add (new sends)  : ${added.length}`);
console.log(`Would drop (phantoms)  : ${dropped.length}`);

if (dryRun) {
  console.log('\n--dry-run: ledger NOT changed.');
  if (dropped.length > 0) {
    console.log(`Sample dropped: ${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ' ...' : ''}`);
  }
  process.exit(0);
}

// Swap the ledger under the same lock the shards use, so an in-flight claim
// cannot be lost between reading and writing.
await withSeenNumbersLock(lockPath, () => {
  if (existsSync(ledgerPath)) {
    const backupPath = path.join(
      path.dirname(ledgerPath),
      `seen-numbers.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    writeFileSync(backupPath, readFileSync(ledgerPath, 'utf8'));
    console.log(`Backup: ${backupPath}`);
  }

  writeFileSync(
    ledgerPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), numbers: [...delivered].sort() }, null, 2)
  );
});

console.log(`Ledger rebuilt: ${delivered.size} delivered number(s), ${dropped.length} phantom(s) released.`);
