// Append-only event log: one JSON line per thing a service does.
//
//   emit({ svc, role, kind, step, account, phase, data })
//
// Design rules (see monitoring plan v2.1):
//   - never throws: monitoring must not be able to break a scrape
//   - one writer per file: the file name includes the role, because a shard's
//     Playwright child and its realtime sender are two processes alive at the
//     same time with the same service name
//   - file name: <svc>-<role>-<inst>-<YYYY-MM-DD>.jsonl

import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, statSync } from 'fs';
import path from 'path';

const MAX_DETAIL = 400;

export function eventsDir(root = process.cwd()) {
  return path.resolve(root, process.env.EVENTS_DIR || 'events');
}

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function eventsFilePath({ svc, role, inst = '1', date = new Date(), root = process.cwd() }) {
  const safe = (v) => String(v).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(eventsDir(root), `${safe(svc)}-${safe(role)}-${safe(inst)}-${dayKey(date)}.jsonl`);
}

function envSvc() {
  return process.env.SERVICE_NAME || 'unknown';
}

function envRole() {
  return process.env.EVENT_ROLE || 'app';
}

function envInst() {
  return String(process.env.INSTANCE_ID || '1');
}

function trimDetail(value) {
  if (typeof value !== 'string') return value;
  return value.length > MAX_DETAIL ? `${value.slice(0, MAX_DETAIL)}…` : value;
}

export function buildEvent(event = {}, defaults = {}) {
  const out = {
    ts: event.ts || new Date().toISOString(),
    svc: event.svc || defaults.svc || envSvc(),
    role: event.role || defaults.role || envRole(),
    inst: String(event.inst || defaults.inst || envInst()),
    kind: event.kind || 'event'
  };

  if (event.step) out.step = event.step;
  if (event.account) out.account = event.account;
  if (event.phase) out.phase = event.phase;
  if (event.batch) out.batch = event.batch;
  out.pid = event.pid || process.pid;

  if (event.data && typeof event.data === 'object') {
    const data = {};
    for (const [key, value] of Object.entries(event.data)) {
      if (value === undefined || value === null) continue;
      data[key] = trimDetail(value);
    }
    if (Object.keys(data).length > 0) out.data = data;
  } else if (event.data !== undefined) {
    out.data = { value: trimDetail(event.data) };
  }

  return out;
}

export function emit(event = {}, defaults = {}) {
  try {
    // Build once, then derive the file name from the resolved values: callers
    // rely on the env fallbacks, and an unresolved name would put every service
    // into one shared file.
    const built = buildEvent(event, defaults);
    const file = eventsFilePath({ svc: built.svc, role: built.role, inst: built.inst });
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(built)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function createEmitter(defaults = {}) {
  return (event = {}) => emit(event, defaults);
}

export function listEventFiles(root = process.cwd()) {
  const dir = eventsDir(root);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const full = path.join(dir, name);
        try {
          const stat = statSync(full);
          return { file: full, name, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    return [];
  }
}

// Read from a byte offset without loading the whole file.
export function readFrom(file, offset = 0) {
  if (!existsSync(file)) return { text: '', offset: 0 };
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size;
    const start = Math.max(0, Math.min(offset, size));
    const length = size - start;
    if (length <= 0) return { text: '', offset: size };
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, start);
    return { text: buffer.subarray(0, read).toString('utf8'), offset: start + read };
  } catch {
    return { text: '', offset };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// Last N bytes of a file, for /tail and startup catch-up.
export function readTail(file, maxBytes = 64 * 1024) {
  if (!existsSync(file)) return '';
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    return readFrom(file, start).text;
  } catch {
    return '';
  }
}

export function parseEventLines(text) {
  const events = [];
  const malformed = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        malformed.push(trimmed);
        continue;
      }
      events.push(parsed);
    } catch {
      malformed.push(trimmed);
    }
  }
  return { events, malformed };
}
