// Single source of truth for the services the monitor and the admin bot know
// about. Paths are resolved against the repository root that is passed in
// (usually process.cwd() of the 1xauto project).
//
// Adding a shard means adding one entry here, not touching the agent and the
// bot separately.

import path from 'path';

export const SERVICE_DEFS = {
  'shard-1': {
    label: 'shard-1 (1-149)',
    dir: '.',
    statusFile: 'loop-status-shard-1.json',
    stateFile: 'state-shard-1.json',
    summaryFile: 'run-summary-shard-1.json',
    screenshotsDir: 'screenshots/shard-1',
    range: [1, 149]
  },
  'shard-2': {
    label: 'shard-2 (150-276)',
    dir: '.',
    statusFile: 'loop-status-shard-2.json',
    stateFile: 'state-shard-2.json',
    summaryFile: 'run-summary-shard-2.json',
    screenshotsDir: 'screenshots/shard-2',
    range: [150, 276]
  },
  melbet: {
    label: 'melbet',
    dir: '../melbet-autologin',
    statusFile: 'loop-status.json',
    stateFile: null,
    // melbet writes its batch data to the log only; the agent derives counts
    // from events, so there is no summary file to read.
    summaryFile: null,
    screenshotsDir: 'screenshots',
    // Five accounts that always fail with "Incorrect username or password"
    // were dropped on 2026-10-31, so the list is 271, not 276.
    range: [1, 271]
  },
  sync: {
    label: 'sync (channel audit)',
    dir: '.',
    statusFile: null,
    stateFile: null,
    summaryFile: null,
    screenshotsDir: null,
    range: null
  }
};

export const SHARD_NAMES = ['shard-1', 'shard-2', 'melbet'];

// Services that represent scraping loops (they have a loop-status file).
export const SCRAPE_SERVICES = ['shard-1', 'shard-2', 'melbet'];

export function serviceDef(name) {
  return SERVICE_DEFS[name] || null;
}

export function resolveServicePath(name, file, root = process.cwd()) {
  const def = SERVICE_DEFS[name];
  if (!def || !file) return null;
  return path.resolve(root, def.dir, file);
}

export function servicePaths(name, root = process.cwd()) {
  const def = SERVICE_DEFS[name];
  if (!def) return null;
  return {
    root: path.resolve(root, def.dir),
    status: resolveServicePath(name, def.statusFile, root),
    state: resolveServicePath(name, def.stateFile, root),
    summary: resolveServicePath(name, def.summaryFile, root),
    screenshots: resolveServicePath(name, def.screenshotsDir, root)
  };
}

export function normalizeServiceName(value) {
  if (!value) return 'unknown';
  const name = String(value).trim().toLowerCase();
  if (name === 'shard1' || name === 'shard-1') return 'shard-1';
  if (name === 'shard2' || name === 'shard-2') return 'shard-2';
  if (name === 'melbet' || name.startsWith('melbet-')) return 'melbet';
  if (name === 'sync' || name === 'telegram-sync') return 'sync';
  return name;
}
