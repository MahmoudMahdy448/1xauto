import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

// Keep the local .env file authoritative over any stale Windows environment variables.
dotenv.config({ override: true });

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  use: {
    headless: false,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 960 }
  }
});
