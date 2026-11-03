// One-shot resume rule for a shard loop.
//
// A shard normally starts every pass at its own range start (START_INDEX). When
// the pipeline is swapped or restarted mid-pass, the first pass should instead
// continue at the account after the last one the saved state recorded, so no
// account is scraped twice in a row.
//
// Kept separate from run-loop.js so the rule is unit tested without spawning a
// whole batch.

export function resumeStartIndex(savedState, baseStartIndex, endIndex) {
  const base = parseInt(baseStartIndex, 10) || 1;
  const last = savedState?.lastProcessedIndex;
  if (typeof last !== 'number' || !Number.isFinite(last)) return base;
  const next = last + 1;
  if (next <= base) return base;
  // A pass that reached the last account of its range is finished. Resuming at
  // one past the end would run an empty pass and then burn a whole cooldown
  // waiting, so a finished range starts again at its own beginning.
  const end = parseInt(endIndex, 10);
  if (Number.isFinite(end) && next > end) return base;
  return next;
}
