export function readState() {
  return null;
}

export function writeState() {}

export function resolveStartIndex(state, explicitStartIndex) {
  if (explicitStartIndex !== undefined && explicitStartIndex !== null) {
    return explicitStartIndex;
  }

  if (state && typeof state.lastProcessedIndex === 'number') {
    return state.lastProcessedIndex + 1;
  }

  return 1;
}
