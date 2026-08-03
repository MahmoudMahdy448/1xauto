import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'fs';
import path from 'path';

export function readSeenNumbers(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return new Set(Array.isArray(parsed?.numbers) ? parsed.numbers : []);
  } catch {
    return new Set();
  }
}

function writeSeenNumbers(filePath, numbers) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  const fd = openSync(tmpPath, 'w');

  try {
    writeSync(
      fd,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          numbers: [...numbers].sort()
        },
        null,
        2
      )
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tmpPath, filePath);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withSeenNumbersLock(lockPath, task) {
  const lockDir = path.resolve(lockPath);
  mkdirSync(path.dirname(lockDir), { recursive: true });

  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring lock ${lockDir}`);
      }
      await sleep(100);
    }
  }

  try {
    return await task();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export async function claimNewNumbers({ filePath, lockPath, numbers }) {
  return withSeenNumbersLock(lockPath, () => {
    const seen = readSeenNumbers(filePath);
    const toAdd = [...new Set(numbers)].filter((n) => !seen.has(n));

    if (toAdd.length > 0) {
      toAdd.forEach((n) => seen.add(n));
      writeSeenNumbers(filePath, seen);
    }

    return toAdd;
  });
}
