export function classifyError() {
  return { retryable: false, category: 'other' };
}

export function isRetryable() {
  return false;
}

export function backoffDelay() {
  return 2000;
}
