import { appendFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { getAccountsToProcess } from '../lib/csv.js';
import { buildScreenshotPath, extractPhoneNumber, fallbackScreenshotPath } from '../lib/extractor.js';
import { buildSummary } from '../lib/runSummary.js';
import { parseProxyUrl, maskProxyPassword } from '../lib/proxy.js';
import { backoffDelay, readMaxRetries, runWithRetry } from '../lib/retry.js';
import { readState, writeState, resolveStartIndex } from '../lib/state.js';

const loginUrl = 'https://eg1xbet.com/en/user/login';
const rechargeUrl = 'https://eg1xbet.com/en/office/recharge';
const accountVerificationUrl = /\/en\/user\/accountverify(?:[/?#]|$)/;
const accountsFilePath = path.resolve(process.cwd(), 'accounts.csv');
const failuresLogPath = path.resolve(process.cwd(), 'logs', 'failed-accounts.log');
const stateFilePath = process.env.STATE_FILE || path.resolve(process.cwd(), 'state.json');
const screenshotCounts = new Map();
const uniqueNumbers = new Set();

function logFailure(account, error) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${account.username} | ${error.message}\n`;

  mkdirSync(path.dirname(failuresLogPath), { recursive: true });
  appendFileSync(failuresLogPath, message, 'utf8');
}

async function runAccountFlow(page, account, index, total) {
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

  console.log(`[${index + 1}/${total}] Signing in with ${username}`);

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
    console.log(`Extracted mobile number: ${extractedNumber}`);
    uniqueNumbers.add(extractedNumber);
    
    // Track duplicates across the entire batch run
    let count = screenshotCounts.get(extractedNumber) || 0;
    count += 1;
    screenshotCounts.set(extractedNumber, count);

    finalScreenshotPath = buildScreenshotPath(extractedNumber, count, (candidatePath) => existsSync(candidatePath));
  } else {
    console.warn('Warning: Egyptian mobile number matching (01\\d{9}) not found in the payment modal.');
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
  console.log(`Screenshot saved to: ${finalScreenshotPath}`);
}

async function runAccountFlowWithRetry(createContext, account, index, total, options) {
  const maxRetries = options.maxRetries ?? readMaxRetries();
  const delayFn = options.delayFn ?? backoffDelay;
  let retriesUsed = 0;

  const result = await runWithRetry(
    async () => {
      const context = await createContext();
      const page = await context.newPage();
      try {
        await runAccountFlow(page, account, index, total);
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
        console.log(
          `[${index + 1}/${total}] Retrying ${retryOrdinal}/${maxRetries} for ${account.username} after ${delayMs}ms (${category})`
        );
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
  console.log(`Loaded ${accounts.length} account(s) from accounts.csv`);

  if (!accounts.length) {
    throw new Error('No accounts available. Add rows to accounts.csv or set environment variables.');
  }

  const proxy = parseProxyUrl(process.env.PROXY_URL);
  const maxRetries = readMaxRetries();
  const runStats = { total: 0, succeeded: 0, failed: 0, retries: 0, categories: {} };

  const batchId = process.env.BATCH_ID || new Date().toISOString();
  let state = readState(stateFilePath);

  if (process.env.BATCH_ID && state && state.batchId !== process.env.BATCH_ID) {
    console.log(
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

  const startIndex = resolveStartIndex(state, explicitStartIndex);
  console.log(`Start index resolved to ${startIndex} (${state ? `state.lastProcessedIndex=${state.lastProcessedIndex}` : 'no state'}${explicitStartIndex ? `, START_INDEX=${explicitStartIndex}` : ''})`);

  if (startIndex > accounts.length) {
    console.warn(`Warning: start index (${startIndex}) is greater than the total number of accounts (${accounts.length}). No accounts will be processed.`);
  }

  if (process.env.DRY_RUN === 'true') {
    console.log(
      `[dry-run] ${accounts.length} account(s) parsed; summary=${JSON.stringify(buildSummary())}; proxy=${proxy ? 'enabled' : 'disabled'}; maxRetries=${maxRetries}; startIndex=${startIndex}`
    );
    return;
  }

  if (proxy) {
    console.log(`Phase: proxy enabled -> ${maskProxyPassword(process.env.PROXY_URL)}`);
  } else {
    console.log('Phase: proxy disabled (PROXY_URL unset)');
  }
  console.log(`Phase: retry ladder enabled -> maxRetries=${maxRetries}`);
  console.log(`Phase: state persistence enabled -> ${stateFilePath}`);

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

  for (const [index, account] of accounts.entries()) {
    if (index + 1 < startIndex) {
      continue;
    }
    const startedAt = Date.now();
    const result = await runAccountFlowWithRetry(
      () => browser.newContext(proxy ? { proxy } : {}),
      account,
      index,
      accounts.length,
      {
        maxRetries,
        onSuccess: () => persistState(index + 1),
        onFailure: () => persistState(index + 1)
      }
    );
    const elapsedMs = Date.now() - startedAt;

    runStats.total += 1;
    runStats.retries += result.retries;

    if (result.outcome === 'success') {
      runStats.succeeded += 1;
      console.log(
        `[${index + 1}/${accounts.length}] Success for ${account.username} (${elapsedMs}ms, retries=${result.retries})`
      );
    } else {
      runStats.failed += 1;
      runStats.categories[result.category] = (runStats.categories[result.category] || 0) + 1;
      console.error(
        `[${index + 1}/${accounts.length}] Failed for ${account.username}: ${result.error.message}`
      );
      logFailure(account, result.error);
    }

    if (index < accounts.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  console.log(
    `Run stats: total=${runStats.total} succeeded=${runStats.succeeded} failed=${runStats.failed} retries=${runStats.retries} categories=${JSON.stringify(runStats.categories)}`
  );

  if (uniqueNumbers.size > 0) {
    const excelData = [...uniqueNumbers].map((num) => ({ Phone: num }));
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Numbers');
    const excelPath = path.resolve(process.cwd(), 'extracted_numbers.xlsx');
    XLSX.writeFile(workbook, excelPath);
    console.log(`Excel file saved to: ${excelPath} (${uniqueNumbers.size} unique numbers)`);
  } else {
    console.warn('No numbers were extracted. Excel file was not created.');
  }
});
