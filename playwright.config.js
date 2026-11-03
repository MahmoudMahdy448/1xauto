import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

// Keep the local .env file authoritative over any stale Windows environment variables.
const explicitHeadless = process.env.HEADLESS;
dotenv.config({ override: true });
if (explicitHeadless !== undefined) {
  process.env.HEADLESS = explicitHeadless;
}

const isWindows = process.platform === 'win32';
const lowMemory = process.env.LOW_MEMORY === 'true';

// Each scraper gets its own cache directory. Chromium cannot share one
// --disk-cache-dir between two browser processes: the second process silently
// gets no cache at all and re-downloads every asset for every account.
// scripts/launch-shard.ps1 sets BROWSER_CACHE_DIR per shard; this fallback keeps
// manual `npm run login` runs behaving exactly as before.
const cacheDir = process.env.BROWSER_CACHE_DIR
  ? path.resolve(process.cwd(), process.env.BROWSER_CACHE_DIR)
  : path.join(process.cwd(), '.browser-cache');

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 0,
  use: {
    // CI (playwright.yml) must set HEADLESS=true; local dev stays headed by default.
    headless: process.env.HEADED === 'true' ? false : process.env.HEADLESS === 'true',
    screenshot: 'off',
    trace: 'off',
    viewport: { width: 1440, height: 960 },
    launchOptions: {
      args: [
        `--disk-cache-dir=${cacheDir}`,
        '--disk-cache-size=536870912',
        ...(lowMemory ? ['--single-process', '--disable-gpu'] : []),
        // Azure/OCI disable Chromium's user-namespace sandbox for normal users,
        // so disable it everywhere except Windows local dev.
        ...(!isWindows ? ['--no-sandbox'] : [])
      ]
    }
  }
});
