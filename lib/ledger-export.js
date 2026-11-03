// Ledger → CSV export.
//
// The ledger (seen-numbers.json) is the single source of truth for every
// number that has ever been sent to Telegram. This module turns it into a
// portable file without touching the ledger itself: read, dedupe, sort, write.
//
// Used by scripts/export-ledger.mjs and by the status bot's /csv command, so
// both always produce the same file shape.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

// Reads {updatedAt, numbers[]} and tolerates a missing or corrupted file by
// returning an empty list instead of throwing into a caller that is answering
// a Telegram command.
export function readLedger(filePath) {
  if (!filePath || !existsSync(filePath)) return { numbers: [], updatedAt: null };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const numbers = Array.isArray(parsed?.numbers) ? parsed.numbers.map((n) => String(n).trim()) : [];
    return {
      numbers: numbers.filter(Boolean),
      updatedAt: parsed?.updatedAt || null
    };
  } catch {
    return { numbers: [], updatedAt: null };
  }
}

function cell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// One number per row, sorted, never duplicated. CRLF so Excel opens it cleanly.
export function buildLedgerCsv(numbers) {
  const unique = [...new Set((numbers || []).map((n) => String(n).trim()).filter(Boolean))].sort();
  const lines = ['number'];
  for (const number of unique) lines.push(cell(number));
  return `${lines.join('\r\n')}\r\n`;
}

// Local-time stamp for the file name: 2026-10-29-2338.
export function fileStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function writeLedgerCsv({ ledgerPath, outDir = 'exports', now = new Date() }) {
  const { numbers, updatedAt } = readLedger(ledgerPath);
  const unique = [...new Set(numbers)].sort();
  const file = path.resolve(outDir, `ledger-${fileStamp(now)}.csv`);
  mkdirSync(path.dirname(file), { recursive: true });
  const csv = buildLedgerCsv(unique);
  writeFileSync(file, csv, 'utf8');
  return {
    file,
    name: path.basename(file),
    count: unique.length,
    updatedAt,
    bytes: Buffer.byteLength(csv)
  };
}
