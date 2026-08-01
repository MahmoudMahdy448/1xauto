import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

// Keep the local .env file authoritative over any stale Windows environment variables.
dotenv.config({ override: true });

export default defineConfig({
  testDir: './tests',
  timeout: 0,
  use: {
    headless: process.env.HEADLESS === 'true',
    screenshot: 'off',
    trace: 'off',
    viewport: { width: 1440, height: 960 },
    launchOptions: {
      args: [
        `--disk-cache-dir=${process.cwd()}\\.browser-cache`,
        '--disk-cache-size=1073741824'
      ]
    }
  }
});
