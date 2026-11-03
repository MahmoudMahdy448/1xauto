// Export the whole seen-numbers ledger as a CSV file.
//
//   node scripts/export-ledger.mjs                 -> exports/ledger-<stamp>.csv
//   node scripts/export-ledger.mjs --out data.csv  -> data.csv
//
// The ledger is never modified: this only reads SEEN_NUMBERS_FILE.

import dotenv from 'dotenv';
import path from 'path';
import { writeLedgerCsv } from '../lib/ledger-export.js';

dotenv.config();

const ledgerPath = path.resolve(process.cwd(), process.env.SEEN_NUMBERS_FILE || 'seen-numbers.json');
const outArg = process.argv.indexOf('--out');
const outDir = path.resolve(process.cwd(), 'exports');

if (process.argv.includes('--help')) {
  console.log('usage: node scripts/export-ledger.mjs [--out <file.csv>]');
  process.exit(0);
}

const out = writeLedgerCsv({
  ledgerPath,
  outDir: outArg >= 0 && process.argv[outArg + 1] ? path.dirname(path.resolve(process.argv[outArg + 1])) : outDir
});

// --out overrides the generated name but keeps the same content.
let finalFile = out.file;
if (outArg >= 0 && process.argv[outArg + 1]) {
  const requested = path.resolve(process.argv[outArg + 1]);
  const { readFileSync, writeFileSync, mkdirSync, unlinkSync } = await import('fs');
  mkdirSync(path.dirname(requested), { recursive: true });
  writeFileSync(requested, readFileSync(out.file));
  try { unlinkSync(out.file); } catch { /* keep the copy */ }
  finalFile = requested;
}

console.log(`[export-ledger] ${out.count} number(s) -> ${finalFile}`);
if (out.updatedAt) console.log(`[export-ledger] ledger updated ${out.updatedAt}`);
