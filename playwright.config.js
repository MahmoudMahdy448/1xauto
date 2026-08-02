import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

// Keep the local .env file authoritative over any stale Windows environment variables.
dotenv.config({ override: true });

const isWindows = process.platform === 'win32';
const lowMemory = process.env.LOW_MEMORY === 'true';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 0,
  use: {
    // CI (playwright.yml) must set HEADLESS=true; local dev stays headed by default.
    headless: process.env.HEADLESS === 'true',
    screenshot: 'off',
    trace: 'off',
    viewport: { width: 1440, height: 960 },
    launchOptions: {
      args: [
        `--disk-cache-dir=${path.join(process.cwd(), '.browser-cache')}`,
        '--disk-cache-size=1073741824',
        ...(lowMemory ? ['--single-process', '--disable-gpu'] : []),
        // Azure/OCI disable Chromium's user-namespace sandbox for normal users,
        // so disable it everywhere except Windows local dev.
        ...(!isWindows ? ['--no-sandbox'] : [])
      ]
    }
  }
});
