export const RETRY_BASE_DELAY_MS = 2000;
export const RETRY_MAX_DELAY_MS = 15000;
export const RETRY_JITTER_MAX_MS = 1000;

const CATEGORY_RULES = [
  { category: 'loginRejected', retryable: false, pattern: /^Login failed:/i },
  {
    category: 'validation',
    retryable: false,
    pattern: /^Set ONEXBET_|must contain different values|before running an account/i
  },
  { category: 'disk', retryable: true, pattern: /ENOSPC/i },
  {
    category: 'network',
    retryable: true,
    pattern: /net::|ERR_|CONNECTION|ETIMEDOUT|ENOTFOUND|ECONN/i
  },
  { category: 'browserClosed', retryable: true, pattern: /closed/i },
  { category: 'domTimeout', retryable: true, pattern: /timeout|timed out|exceeded/i }
];

export function classifyError(error) {
  const message = error && error.message ? String(error.message) : '';
  const rule = CATEGORY_RULES.find((entry) => entry.pattern.test(message));
  if (rule) {
    return { retryable: rule.retryable, category: rule.category };
  }
  return { retryable: false, category: 'other' };
}

export function isRetryable(error) {
  return classifyError(error).retryable;
}

export function readMaxRetries(env = process.env) {
  const raw = env.MAX_RETRIES;
  if (raw == null || raw === '') {
    return 2;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `Invalid MAX_RETRIES: "${raw}". It must be an integer >= 1.`
    );
  }
  return value;
}

export function backoffDelay(attempt, options = {}) {
  const {
    baseMs = RETRY_BASE_DELAY_MS,
    maxMs = RETRY_MAX_DELAY_MS,
    jitterMaxMs = RETRY_JITTER_MAX_MS,
    random = Math.random
  } = options;
  const jitter = Math.floor(random() * jitterMaxMs);
  return Math.min(baseMs * 2 ** attempt, maxMs) + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWithRetry(attemptFn, options = {}) {
  const maxRetries = options.maxRetries ?? readMaxRetries(options.env);
  const delayFn = options.delayFn ?? backoffDelay;
  const onRetry = options.onRetry ?? (async () => {});
  const onSuccess = options.onSuccess ?? (async () => {});
  const onFailure = options.onFailure ?? (async () => {});
  let retries = 0;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const value = await attemptFn(attempt);
      await onSuccess({ retries, error: null, category: null, value });
      return { outcome: 'success', retries, error: null, category: null, value };
    } catch (error) {
      lastError = error;
      const { retryable, category } = classifyError(error);
      const hasAttemptsLeft = attempt + 1 < maxRetries;
      if (!retryable || !hasAttemptsLeft) {
        await onFailure({ retries, error, category });
        return { outcome: 'failure', retries, error, category };
      }
      retries += 1;
      const delayMs = delayFn(attempt);
      await onRetry({ retryOrdinal: attempt + 1, maxRetries, error, category, delayMs });
      await sleep(delayMs);
    }
  }

  return {
    outcome: 'failure',
    retries,
    error: lastError,
    category: lastError ? classifyError(lastError).category : 'other'
  };
}
