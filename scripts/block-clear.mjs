// block-clear.mjs — manual escape hatch for the IP-block circuit breaker.
//
// The breaker is self-healing: the first login that succeeds after the wait
// clears it. This script exists for the cases that cannot heal themselves:
//   - the IP is accepted again and the operator does not want to wait;
//   - a proxy was added, so the old block no longer applies.
//
//   node scripts/block-clear.mjs          # show the state, change nothing
//   node scripts/block-clear.mjs --yes    # clear it; loops resume next turn

import dotenv from 'dotenv';
import { readSiteBlock, markSiteUnblocked } from '../lib/site-block.js';
import { sendSiteUnblockedAlert } from '../lib/site-block-notify.js';

dotenv.config();

const confirmed = process.argv.includes('--yes');
const block = readSiteBlock();

if (!block.blocked) {
  console.log('[block] already clear — nothing to do');
  if (block.recoveredAt) console.log(`[block] last recovery ${block.recoveredAt}`);
  process.exit(0);
}

const who = block.detectedBy
  ? `${block.detectedBy.shard || 'unknown'}${block.detectedBy.account ? ` (${block.detectedBy.account})` : ''}`
  : 'unknown';

console.log('[block] 1xbet is refusing logins from this IP');
console.log(`  seen        ${block.detectedAt || 'unknown'}`);
console.log(`  detected by ${who}`);
console.log(`  reason      ${block.reason || 'n/a'}`);
console.log(`  retry at    ${block.blockedUntil || 'n/a'}`);
console.log(`  block #     ${block.blockCount || 0}`);

if (!confirmed) {
  console.log('');
  console.log('[block] dry run. Re-run with --yes to let the shards try again.');
  process.exit(0);
}

const result = markSiteUnblocked({ account: 'operator', shard: 'manual' });
if (!result.changed) {
  console.log('[block] another process changed it first — re-read with the status bot /status');
  process.exit(0);
}

console.log('[block] cleared — shards resume at their next loop turn');

const sent = await sendSiteUnblockedAlert({ block: result.block });
if (sent.failed.length) {
  console.warn(`[block] recovery notice failed: ${JSON.stringify(sent.failed)}`);
}
