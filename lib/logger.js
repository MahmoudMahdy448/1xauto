import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';

const LEVEL_WIDTH = 7;

export function formatLogLine({ level, message, fields = {}, ts = new Date() }) {
  const stamp = ts.toISOString();
  const levelTag = `[${level}]`.padEnd(LEVEL_WIDTH);
  const meta = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `[${key}=${value}]`)
    .join(' ');
  const metaPart = meta ? ` ${meta}` : '';
  return `[${stamp}] ${levelTag}${metaPart} ${message}`;
}

export function createLogger(options = {}) {
  const { stream = process.stdout, errorStream = process.stderr, logFile = null } = options;

  const write = (line, isError) => {
    (isError ? errorStream : stream).write(`${line}\n`);
    if (logFile) {
      mkdirSync(path.dirname(logFile), { recursive: true });
      appendFileSync(logFile, `${line}\n`, 'utf8');
    }
  };

  return {
    info: (message, fields) => write(formatLogLine({ level: 'info', message, fields }), false),
    warn: (message, fields) => write(formatLogLine({ level: 'warn', message, fields }), false),
    error: (message, fields) => write(formatLogLine({ level: 'error', message, fields }), true)
  };
}
