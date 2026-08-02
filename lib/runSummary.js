export const FAILURE_CATEGORIES = [
  'network',
  'domTimeout',
  'loginRejected',
  'disk',
  'browserClosed',
  'validation',
  'other'
];

function safeDivide(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function buildSummary(input) {
  const {
    batchId = null,
    startedAt = null,
    endedAt = null,
    totalAccounts = 0,
    startIndex = 1,
    lastProcessedIndex = 0,
    proxyEnabled = false,
    maxRetries = 2,
    uniqueNumbers = 0,
    screenshots = [],
    results = []
  } = input;

  const succeeded = results.filter((r) => r.outcome === 'success').length;
  const failed = results.filter((r) => r.outcome === 'failure').length;
  const accountsRetried = results.filter((r) => r.retries > 0).length;
  const retryCount = results.reduce((sum, r) => sum + (r.retries || 0), 0);

  let slowestAccount = null;
  for (const result of results) {
    if (!slowestAccount || result.runtimeMs > slowestAccount.runtimeMs) {
      slowestAccount = { username: result.username, runtimeMs: result.runtimeMs };
    }
  }

  const failureCategories = {};
  for (const category of FAILURE_CATEGORIES) {
    failureCategories[category] = 0;
  }
  for (const result of results) {
    if (result.outcome === 'failure' && failureCategories[result.category] !== undefined) {
      failureCategories[result.category] += 1;
    }
  }

  const durationMs = startedAt && endedAt ? Math.max(0, new Date(endedAt) - new Date(startedAt)) : 0;

  return {
    batchId,
    startedAt,
    endedAt,
    durationMs,
    totalAccounts,
    succeeded,
    failed,
    accountsRetried,
    retryCount,
    successRate: safeDivide(succeeded, totalAccounts),
    uniqueNumbers,
    avgRuntimePerAccountMs: Math.round(safeDivide(durationMs, results.length)),
    slowestAccount,
    failureCategories,
    screenshotsRetained: screenshots.length,
    artifactNames: screenshots,
    startIndex,
    lastProcessedIndex,
    proxyEnabled,
    maxRetries
  };
}

export function formatSummary(summary) {
  const pct = (summary.successRate * 100).toFixed(1).replace(/\.0$/, '');
  const parts = [
    `Success rate: ${pct}% (${summary.succeeded}/${summary.totalAccounts})`,
    `unique numbers: ${summary.uniqueNumbers}`
  ];

  if (summary.slowestAccount) {
    const seconds = Math.round(summary.slowestAccount.runtimeMs / 1000);
    parts.push(`slowest: ${summary.slowestAccount.username} (${seconds}s)`);
  }

  const categories = FAILURE_CATEGORIES.filter((c) => summary.failureCategories[c] > 0);
  if (categories.length > 0) {
    parts.push(categories.map((c) => `${c}: ${summary.failureCategories[c]}`).join(', '));
  }

  return parts.join(' · ');
}
