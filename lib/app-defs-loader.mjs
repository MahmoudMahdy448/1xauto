// Load APP_DEFS from a JSON file (avoids env var truncation issues with long values)
import { readFileSync } from 'fs';
import path from 'path';

let appDefs = null;

function loadAppDefs() {
  if (appDefs) return appDefs;
  
  // Try env var first (for backward compat)
  if (process.env.APP_DEFS_JSON) {
    try {
      const parsed = JSON.parse(process.env.APP_DEFS_JSON);
      if (Array.isArray(parsed)) { appDefs = parsed; return appDefs; }
    } catch {
      // fall through
    }
  }
  
  // Try JSON file
  const jsonPath = process.env.APP_DEFS_FILE || path.join(process.cwd(), 'app-defs.json');
  try {
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
    if (Array.isArray(data)) { appDefs = data; return appDefs; }
  } catch {
    // fall through
  }
  
  return defaultAppDefs();
}

function defaultAppDefs() {
  return [
    {
      name: '1xauto',
      dir: '/opt/1xauto',
      group: 'A',
      services: ['1xauto-shard-1', '1xauto-shard-2'],
      shards: [
        { service: '1xauto-shard-1', startIndex: 1, endIndex: 69, stateFile: 'state-shard-1.json', summaryFile: 'run-summary-shard-1.json', screenshotsDir: 'screenshots/shard-1', loopStatusFile: 'loop-status-shard-1.json' },
        { service: '1xauto-shard-2', startIndex: 70, endIndex: 138, stateFile: 'state-shard-2.json', summaryFile: 'run-summary-shard-2.json', screenshotsDir: 'screenshots/shard-2', loopStatusFile: 'loop-status-shard-2.json' }
      ],
      seenNumbersFile: 'seen-numbers.json',
      logFilter: 'account=|state'
    },
    {
      name: 'linebet',
      dir: '/opt/linebet',
      group: 'B',
      services: [],
      shards: [
        { service: 'linebet', remote: true, startIndex: 1, endIndex: 44, stateFile: 'state-shard-1.json', summaryFile: 'run-summary-shard-1.json', screenshotsDir: 'screenshots', loopStatusFile: 'loop-status-shard-1.json' }
      ],
      seenNumbersFile: 'seen-numbers.json',
      logFilter: 'Signing in|Screenshot saved|Failed for|Loaded|Extracted'
    },
    {
      name: 'melbet',
      dir: '/opt/melbet',
      group: 'B',
      services: [],
      shards: [
        { service: 'melbet', remote: true, startIndex: 1, endIndex: 92, stateFile: 'state-shard-1.json', summaryFile: 'run-summary-shard-1.json', screenshotsDir: 'screenshots', loopStatusFile: 'loop-status-shard-1.json' }
      ],
      seenNumbersFile: 'seen-numbers.json',
      logFilter: 'Signing in|Screenshot saved|Failed for|Loaded|Extracted'
    }
  ];
}

export const APP_DEFS = loadAppDefs();
