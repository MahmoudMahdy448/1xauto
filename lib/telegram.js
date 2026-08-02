export function buildTelegramMessage(summary) {
  const status = summary.failed > 0 ? '⚠️ partial failures' : 'OK';
  const lines = [
    `Batch ${summary.batchId || 'n/a'} — ${status}`,
    `Success rate: ${(summary.successRate * 100).toFixed(1)}% (${summary.succeeded}/${summary.totalAccounts})`,
    `Processed: ${summary.lastProcessedIndex}/${summary.totalAccounts}`,
    `Unique numbers: ${summary.uniqueNumbers}`,
    `Screenshots: ${summary.screenshotsRetained}`,
    `Duration: ${Math.round(summary.durationMs / 1000)}s`
  ];

  if (summary.retryCount > 0) {
    lines.push(`Retries: ${summary.retryCount}`);
  }

  return lines.join('\n');
}

export function buildTelegramUrl(botToken) {
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

export async function sendTelegramMessage({ botToken, chatId, text }) {
  const response = await fetch(buildTelegramUrl(botToken), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${body}`);
  }

  return response.json();
}
