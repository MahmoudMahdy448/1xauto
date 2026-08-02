import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { getAccountsToProcess } from '../lib/csv.js';
import { buildScreenshotPath, extractPhoneNumber, fallbackScreenshotPath } from '../lib/extractor.js';
import { createLogger } from '../lib/logger.js';
import { buildSummary, formatSummary } from '../lib/runSummary.js';
import { parseProxyUrl, maskProxyPassword } from '../lib/proxy.js';
import { backoffDelay, readMaxRetries, runWithRetry } from '../lib/retry.js';
import { readState, writeState, resolveStartIndex, resolveEndIndex } from '../lib/state.js';

const loginUrl = 'https://eg1xbet.com/en/user/login';
const rechargeUrl = 'https://eg1xbet.com/en/office/recharge';
const accountVerificationUrl = /\/en\/user\/accountverify(?:[/?#]|$)/;
const accountsFilePath = path.resolve(process.cwd(), 'accounts.csv');
const failuresLogPath = path.resolve(process.cwd(), 'logs', 'failed-accounts.log');
const stateFilePath = process.env.STATE_FILE || path.resolve(process.cwd(), 'state.json');
const runSummaryPath = process.env.RUN_SUMMARY_FILE || path.resolve(process.cwd(), 'run-summary.json');
const screenshotCounts = new Map();
const uniqueNumbers = new Set();

function logFailure(account, error) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${account.username} | ${error.message}\n`;

  mkdirSync(path.dirname(failuresLogPath), { recursive: true });
  appendFileSync(failuresLogPath, message, 'utf8');
}

function writeRunSummary(summary) {
  mkdirSync(path.dirname(runSummaryPath), { recursive: true });
  writeFileSync(runSummaryPath, JSON.stringify(summary, null, 2), 'utf8');
}

async function runAccountFlow(page, account, index, total, logger) {
  const { username, password, surname } = account;

  if (!username || !password) {
    throw new Error(
      'Set ONEXBET_USERNAME and ONEXBET_PASSWORD in your environment or .env file, or add rows to accounts.csv.'
    );
  }

  if (surname && password === surname) {
    throw new Error(
      'ONEXBET_PASSWORD and ONEXBET_SURNAME must contain different values.'
    );
  }

  logger.info(`[${index + 1}/${total}] signing in`, { account: username, phase: 'login' });

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  const loginInput = page.locator('input#username');
  const passwordInput = page.locator('input#username-password');
  const submitButton = page.locator('button.auth-form-fields__submit');

  await expect(loginInput).toBeVisible({ timeout: 30_000 });
  await expect(passwordInput).toBeVisible({ timeout: 30_000 });
  await expect(submitButton).toBeEnabled();

  await loginInput.fill(username);
  await passwordInput.fill(password);

  await expect(submitButton).toBeVisible();
  await submitButton.click();

  await page.waitForURL(
    (url) => !url.toString().includes('/user/login'),
    { timeout: 10_000 }
  ).catch(() => {});

  const currentUrl = page.url();
  const loginFormStillVisible = await loginInput.isVisible().catch(() => false);

  if (currentUrl.includes('/user/login') && loginFormStillVisible) {
    const loginErrorHint = await page
      .locator('text=/incorrect|invalid|wrong|password|login/i')
      .first()
      .textContent()
      .catch(() => '');

    throw new Error(
      loginErrorHint
        ? `Login failed: ${loginErrorHint.trim()}`
        : 'Login failed; the credentials may be invalid or the site rejected the login attempt.'
    );
  }

  await page.waitForURL(accountVerificationUrl, { timeout: 10_000 }).catch(() => {});

  if (accountVerificationUrl.test(page.url())) {
    if (!surname) {
      throw new Error(
        'Set ONEXBET_SURNAME before running an account verification flow.'
      );
    }

    const surnameInput = page.getByRole('textbox');
    const verificationSubmit = page.getByRole('button', {
      name: 'Confirm',
      exact: true
    });

    await expect(surnameInput).toHaveCount(1);
    await expect(verificationSubmit).toHaveCount(1);

    await surnameInput.fill(surname);
    await expect(verificationSubmit).toBeEnabled();
    await verificationSubmit.click();
    await page.waitForTimeout(2_000);
  }

  await page.goto(rechargeUrl, { waitUntil: 'domcontentloaded' });

  const paymentFrame = page.frameLocator(
    'iframe[src*="/paysystems/deposit/"]'
  );
  const vodafoneOption = paymentFrame.locator('#vodafone_1');
  const paymentModal = paymentFrame.locator('#payment_modal_container');

  await expect(vodafoneOption).toBeVisible({ timeout: 30_000 });
  await vodafoneOption.click();

  await expect(paymentModal).toBeVisible({ timeout: 15_000 });
  await expect(paymentFrame.locator('#amount')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_000);

  const modalBox = await paymentModal.boundingBox();
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));

  if (!modalBox) {
    throw new Error('Could not determine the Vodafone payment window position.');
  }

  const copyBtn = paymentFrame.locator('#payment_modal_container span.copy_content_btn.modal-message-btn[title="Copy"]');

  // Wait for the copy button to be visible
  await expect(copyBtn.first()).toBeVisible({ timeout: 20_000 });

  const copyButtonsCount = await copyBtn.count();
  let extractedNumber = '';

  for (let i = 0; i < copyButtonsCount; i++) {
    const btn = copyBtn.nth(i);

    // Try to get data-clipboard-text attribute
    const clipboardText = await btn.getAttribute('data-clipboard-text').catch(() => null);
    extractedNumber = extractPhoneNumber(clipboardText);
    if (extractedNumber) {
      break;
    }

    // Try to get data-text attribute
    const dataText = await btn.getAttribute('data-text').catch(() => null);
    extractedNumber = extractPhoneNumber(dataText);
    if (extractedNumber) {
      break;
    }

    // Try to get text content of the button itself
    const btnText = await btn.textContent().catch(() => '');
    extractedNumber = extractPhoneNumber(btnText);
    if (extractedNumber) {
      break;
    }

    // Try to get text content of parent
    const parentText = await btn.evaluate(node => node.parentElement ? node.parentElement.textContent : '').catch(() => '');
    extractedNumber = extractPhoneNumber(parentText);
    if (extractedNumber) {
      break;
    }
  }

  // Fallback to the whole modal container text if still not found
  if (!extractedNumber) {
    const modalText = await paymentModal.textContent().catch(() => '');
    extractedNumber = extractPhoneNumber(modalText);
  }

  let finalScreenshotPath;
  if (extractedNumber) {
    logger.info(`extracted mobile number ${extractedNumber}`, { account: username, phase: 'payment' });
    uniqueNumbers.add(extractedNumber);
    
    // Track duplicates across the entire batch run
    let count = screenshotCounts.get(extractedNumber) || 0;
    count += 1;
    screenshotCounts.set(extractedNumber, count);

    finalScreenshotPath = buildScreenshotPath(extractedNumber, count, (candidatePath) => existsSync(candidatePath));
  } else {
    logger.warn('Egyptian mobile number matching (01\\d{9}) not found in the payment modal.', { account: username, phase: 'payment' });
    const screenshotTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    finalScreenshotPath = fallbackScreenshotPath(screenshotTimestamp);
  }

  // Ensure the directory exists
  mkdirSync(path.dirname(finalScreenshotPath), { recursive: true });

  await page.screenshot({
    path: finalScreenshotPath,
    clip: {
      x: 0,
      y: 0,
      width: viewport.width,
      height: Math.ceil(modalBox.y + modalBox.height)
    }
  });
  logger.info(`screenshot saved ${finalScreenshotPath}`, { account: username, phase: 'payment' });
  return finalScreenshotPath;
}

async function runAccountFlowWithRetry(createContext, account, index, total, options) {
  const maxRetries = options.maxRetries ?? readMaxRetries();
  const delayFn = options.delayFn ?? backoffDelay;
  const logger = options.logger;
  let retriesUsed = 0;

  const result = await runWithRetry(
    async () => {
      const context = await createContext();
      const page = await context.newPage();
      try {
        return await runAccountFlow(page, account, index, total, logger);
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    },
    {
      maxRetries,
      delayFn,
      onRetry: ({ retryOrdinal, error, category, delayMs }) => {
        retriesUsed += 1;
        logger.warn(`retry ${retryOrdinal}/${maxRetries} in ${delayMs}ms (${category})`, { account: account.username, phase: 'login' });
        if (options.onRetry) {
          options.onRetry({ account, retryOrdinal, error, category, delayMs });
        }
      },
      onSuccess: (outcome) => {
        if (options.onSuccess) {
          return options.onSuccess({ account, index, total, ...outcome });
        }
        return undefined;
      },
      onFailure: (outcome) => {
        if (options.onFailure) {
          return options.onFailure({ account, index, total, ...outcome });
        }
        return undefined;
      }
    }
  );

  return { ...result, retries: retriesUsed };
}

test('sign in to 1xBet', async ({ browser }) => {
  test.setTimeout(0);
  screenshotCounts.clear();
  uniqueNumbers.clear();

  const accounts = getAccountsToProcess(accountsFilePath);
  const logger = createLogger({
    logFile: path.resolve(process.cwd(), 'logs', `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  });
  logger.info(`loaded ${accounts.length} account(s) from accounts.csv`);

  if (!accounts.length) {
    throw new Error('No accounts available. Add rows to accounts.csv or set environment variables.');
  }

  const proxy = parseProxyUrl(process.env.PROXY_URL);
  const maxRetries = readMaxRetries();

  const batchId = process.env.BATCH_ID || new Date().toISOString();
  let state = readState(stateFilePath);

  if (process.env.BATCH_ID && state && state.batchId !== process.env.BATCH_ID) {
    logger.info(
      `BATCH_ID changed (state=${state.batchId} vs env=${process.env.BATCH_ID}); starting fresh at 1`
    );
    state = null;
  }

  const startIndexEnv = process.env.START_INDEX;
  let explicitStartIndex;
  if (startIndexEnv) {
    explicitStartIndex = parseInt(startIndexEnv, 10);
    if (isNaN(explicitStartIndex) || explicitStartIndex < 1) {
      throw new Error(`Invalid START_INDEX: "${startIndexEnv}". It must be a positive integer starting from 1.`);
    }
  }

  const endIndexEnv = process.env.END_INDEX;
  let endIndex = accounts.length;
  if (endIndexEnv) {
    const parsedEndIndex = parseInt(endIndexEnv, 10);
    if (isNaN(parsedEndIndex)) {
      throw new Error(`Invalid END_INDEX: "${endIndexEnv}". It must be a positive integer.`);
    }
    endIndex = resolveEndIndex(parsedEndIndex, accounts.length);
    if (endIndex !== parsedEndIndex) {
      logger.warn(`END_INDEX (${parsedEndIndex}) is greater than the total number of accounts (${accounts.length}); clamping to ${endIndex}.`);
    }
  }

  const startIndex = resolveStartIndex(state, explicitStartIndex);
  logger.info(`start index resolved to ${startIndex} (${state ? `state.lastProcessedIndex=${state.lastProcessedIndex}` : 'no state'}${explicitStartIndex ? `, START_INDEX=${explicitStartIndex}` : ''})`);

  if (startIndex > accounts.length) {
    logger.warn(`start index (${startIndex}) is greater than the total number of accounts (${accounts.length}). No accounts will be processed.`);
  }

  if (process.env.DRY_RUN === 'true') {
    const dryRunSummary = buildSummary({
      batchId,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      totalAccounts: accounts.length,
      startIndex,
      lastProcessedIndex: state ? state.lastProcessedIndex : 0,
      proxyEnabled: !!proxy,
      maxRetries,
      uniqueNumbers: uniqueNumbers.size,
      screenshots: [],
      results: []
    });
    writeRunSummary(dryRunSummary);
    logger.info(
      `[dry-run] ${accounts.length} account(s) parsed; proxy=${proxy ? 'enabled' : 'disabled'}; maxRetries=${maxRetries}; startIndex=${startIndex}`
    );
    logger.info(formatSummary(dryRunSummary));
    return;
  }

  if (process.env.ALLOW_LIVE_RUN !== 'true') {
    throw new Error(
      'Live execution blocked: set ALLOW_LIVE_RUN=true to run against the live site (or DRY_RUN=true to validate without navigation).'
    );
  }

  logger.info(`proxy ${proxy ? `enabled -> ${maskProxyPassword(process.env.PROXY_URL)}` : 'disabled (PROXY_URL unset)'}`);
  logger.info(`retry ladder enabled -> maxRetries=${maxRetries}`);
  logger.info(`state persistence enabled -> ${stateFilePath}`);

  const persistState = (lastProcessedIndex) => {
    writeState(
      {
        batchId,
        lastProcessedIndex,
        totalAccounts: accounts.length,
        updatedAt: new Date().toISOString()
      },
      stateFilePath
    );
  };

  const runStartedAt = new Date();
  const runResults = [];
  const screenshots = [];

  logger.info(`processing range [${startIndex}, ${endIndex}] of ${accounts.length} account(s)`);

  for (const [index, account] of accounts.entries()) {
    if (index + 1 < startIndex) {
      continue;
    }
    if (index + 1 > endIndex) {
      logger.info(`end index reached at ${endIndex}; stopping this shard.`);
      break;
    }
    const startedAt = Date.now();
    const result = await runAccountFlowWithRetry(
      () => browser.newContext(proxy ? { proxy } : {}),
      account,
      index,
      accounts.length,
      {
        maxRetries,
        logger,
        onSuccess: () => persistState(index + 1),
        onFailure: () => persistState(index + 1)
      }
    );
    const elapsedMs = Date.now() - startedAt;

    runResults.push({
      username: account.username,
      outcome: result.outcome,
      retries: result.retries,
      runtimeMs: elapsedMs,
      category: result.category
    });

    if (result.outcome === 'success') {
      logger.info(
        `success for ${account.username} (${elapsedMs}ms, retries=${result.retries})`,
        { account: account.username, phase: 'account' }
      );
      if (result.value) {
        screenshots.push(result.value);
      }
    } else {
      logger.error(
        `failed for ${account.username}: ${result.error.message}`,
        { account: account.username, phase: 'account' }
      );
      logFailure(account, result.error);
    }

    if (index < accounts.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  const summary = buildSummary({
    batchId,
    startedAt: runStartedAt.toISOString(),
    endedAt: new Date().toISOString(),
    totalAccounts: accounts.length,
    startIndex,
    lastProcessedIndex: runResults.length ? startIndex + runResults.length - 1 : startIndex - 1,
    proxyEnabled: !!proxy,
    maxRetries,
    uniqueNumbers: uniqueNumbers.size,
    screenshots,
    results: runResults
  });
  writeRunSummary(summary);
  logger.info(formatSummary(summary));

  if (uniqueNumbers.size > 0) {
    const excelData = [...uniqueNumbers].map((num) => ({ Phone: num }));
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Numbers');
    const excelPath = process.env.EXCEL_FILE || path.resolve(process.cwd(), 'extracted_numbers.xlsx');
    XLSX.writeFile(workbook, excelPath);
    logger.info(`excel file saved to: ${excelPath} (${uniqueNumbers.size} unique numbers)`);
  } else {
    logger.warn('No numbers were extracted. Excel file was not created.');
  }
});
