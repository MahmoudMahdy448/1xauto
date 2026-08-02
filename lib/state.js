import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync
} from 'fs';
import path from 'path';

export function readState(stateFilePath) {
  if (!stateFilePath || !existsSync(stateFilePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(stateFilePath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(state, stateFilePath) {
  const dir = path.dirname(stateFilePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${stateFilePath}.tmp`;
  const fd = openSync(tmpPath, 'w');

  try {
    writeSync(fd, JSON.stringify(state, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tmpPath, stateFilePath);
}

export function resolveStartIndex(state, explicitStartIndex) {
  if (explicitStartIndex !== undefined && explicitStartIndex !== null) {
    return explicitStartIndex;
  }

  if (state && typeof state.lastProcessedIndex === 'number') {
    return state.lastProcessedIndex + 1;
  }

  return 1;
}
