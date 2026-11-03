// gate-clear.mjs — manual escape hatch for the deposit gate.
//
// The gate is self-healing: the first account (or probe) that pulls a real
// phone number clears it. This script exists for the two cases that cannot
// heal themselves:
//   - the site came back while every probe account is broken;
//   - an operator knows the wallet is fine and does not want to wait.
//
//   node scripts/gate-clear.mjs          # show the state, change nothing
//   node scripts/gate-clear.mjs --yes    # clear it and send the recovery alert

import dotenv from 'dotenv';
import { readGate, markEnabled, cairoTime } from '../lib/deposit-gate.js';
import { sendGateAlert } from '../lib/deposit-gate-notify.js';

dotenv.config();

const confirmed = process.argv.includes('--yes');
const gate = readGate();

if (!gate.disabled) {
  console.log('[gate] already clear — nothing to do');
  if (gate.restoredAt) console.log(`[gate] last restored ${gate.restoredAt}`);
  process.exit(0);
}

const who = gate.detectedBy
  ? `${gate.detectedBy.shard || 'unknown'}${gate.detectedBy.account ? ` (${gate.detectedBy.account})` : ''}`
  : 'unknown';

console.log('[gate] vodafone is disabled');
console.log(`  since       ${gate.since || 'unknown'} (${cairoTime(gate.since)} Cairo)`);
console.log(`  detected by ${who}`);
console.log(`  reason      ${gate.reason || 'n/a'}`);
console.log(`  probes      ${gate.probeCount || 0} · failures in a row ${gate.probeFailures || 0}`);
console.log(`  next check  ${gate.nextCheckAt || 'n/a'} (${cairoTime(gate.nextCheckAt)} Cairo)`);
if (gate.lastProbeError) console.log(`  last error  ${gate.lastProbeError}`);

if (!confirmed) {
  console.log('');
  console.log('[gate] dry run. Re-run with --yes to resume the shards.');
  process.exit(0);
}

const result = markEnabled({ account: 'operator', shard: 'manual' });
if (!result.changed) {
  console.log('[gate] another process changed the gate first — re-read it with the status bot /gate');
  process.exit(0);
}

console.log('[gate] cleared — shards resume at their next loop turn');

if (result.notify) {
  const sent = await sendGateAlert({ kind: 'enabled', gate: result.gate });
  if (sent.failed.length) {
    console.warn(`[gate] recovery alert partially failed: ${JSON.stringify(sent.failed)}`);
  }
}
