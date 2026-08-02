import path from 'node:path';

const PHONE_NUMBER_RE = /01\d{9}/;
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || 'screenshots';

export function extractPhoneNumber(text) {
  const match = text ? text.match(PHONE_NUMBER_RE) : null;
  return match ? match[0] : '';
}

export function buildScreenshotPath(number, count, existing) {
  let candidate = count;
  let result;

  do {
    const filename = candidate === 1 ? `${number}.png` : `${number}(${candidate}).png`;
    result = path.join(SCREENSHOTS_DIR, filename);
    candidate += 1;
  } while (existing(result));

  return result;
}

export function fallbackScreenshotPath(timestamp) {
  return path.join(SCREENSHOTS_DIR, `vodafone-deposit-${timestamp}.png`);
}
