import { buildStatusText } from '../lib/status.js';

console.log(buildStatusText({ appDir: process.cwd() }));
console.log('\nTo watch live: journalctl -u 1xauto-shard-1 -f');
