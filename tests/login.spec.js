import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';

const loginUrl = 'https://eg1xbet.com/en/user/login';
const rechargeUrl = 'https://eg1xbet.com/en/office/recharge';
const accountVerificationUrl = /\/en\/user\/accountverify(?:[/?#]|$)/;
const accountsFilePath = path.resolve(process.cwd(), 'accounts.csv');
const failuresLogPath = path.resolve(process.cwd(), 'logs', 'failed-accounts.log');
const screenshotCounts = new Map();

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      const nextCharacter = line[index + 1];

      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }

  values.push(current.trim());
  return values;
}

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);

    return headers.reduce((row, header, index) => {
      row[header] = values[index] || '';
      return row;
    }, {});
  });
}

function loadAccounts() {
  if (!existsSync(accountsFilePath)) {
    return [];
  }

  const csvText = readFileSync(accountsFilePath, 'utf8');
  const rows = parseCsv(csvText);

  return rows
    .map((row) => ({
      username: row.username || '',
      password: row.password || '',
      surname: row.surname || ''
    }))
    .filter((account) => account.username && account.password);
}

function getAccountsToProcess() {
  const accountsFromCsv = loadAccounts();

  if (accountsFromCsv.length > 0) {
    return accountsFromCsv;
  }

  return [
    {
      username: process.env.ONEXBET_USERNAME || '',
      password: process.env.ONEXBET_PASSWORD || '',
      surname: process.env.ONEXBET_SURNAME || ''
    }
  ];
}

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
    let match = clipboardText ? clipboardText.match(/01\d{9}/) : null;
    if (match) {
      extractedNumber = match[0];
      break;
    }

    // Try to get data-text attribute
    const dataText = await btn.getAttribute('data-text').catch(() => null);
    match = dataText ? dataText.match(/01\d{9}/) : null;
    if (match) {
      extractedNumber = match[0];
      break;
    }

    // Try to get text content of the button itself
    const btnText = await btn.textContent().catch(() => '');
    match = btnText ? btnText.match(/01\d{9}/) : null;
    if (match) {
      extractedNumber = match[0];
      break;
    }

    // Try to get text content of parent
    const parentText = await btn.evaluate(node => node.parentElement ? node.parentElement.textContent : '').catch(() => '');
    match = parentText ? parentText.match(/01\d{9}/) : null;
    if (match) {
      extractedNumber = match[0];
      break;
    }
  }

  // Fallback to the whole modal container text if still not found
  if (!extractedNumber) {
    const modalText = await paymentModal.textContent().catch(() => '');
    const match = modalText ? modalText.match(/01\d{9}/) : null;
    if (match) {
      extractedNumber = match[0];
    }
  }

  let finalScreenshotPath;
  if (extractedNumber) {
    console.log(`Extracted mobile number: ${extractedNumber}`);
    
    // Track duplicates across the entire batch run
    let count = screenshotCounts.get(extractedNumber) || 0;
    count += 1;
    screenshotCounts.set(extractedNumber, count);

    let currentCount = count;
    do {
      const filename = currentCount === 1 ? `${extractedNumber}.png` : `${extractedNumber}(${currentCount}).png`;
      finalScreenshotPath = path.join('screenshots', filename);
      currentCount++;
    } while (existsSync(finalScreenshotPath));
  } else {
    console.warn('Warning: Egyptian mobile number matching (01\\d{9}) not found in the payment modal.');
    const screenshotTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    finalScreenshotPath = path.join('screenshots', `vodafone-deposit-${screenshotTimestamp}.png`);
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

test('sign in to 1xBet', async ({ browser }) => {
  test.setTimeout(0);
  screenshotCounts.clear();

  const accounts = getAccountsToProcess();
  console.log(`Loaded ${accounts.length} account(s) from accounts.csv`);

  if (!accounts.length) {
    throw new Error('No accounts available. Add rows to accounts.csv or set environment variables.');
  }

  const startIndexEnv = process.env.START_INDEX;
  let startIndex = 1;
  if (startIndexEnv) {
    startIndex = parseInt(startIndexEnv, 10);
    if (isNaN(startIndex) || startIndex < 1) {
      throw new Error(`Invalid START_INDEX: "${startIndexEnv}". It must be a positive integer starting from 1.`);
    }
    console.log(`START_INDEX is set. Starting execution from record ${startIndex}`);
    if (startIndex > accounts.length) {
      console.warn(`Warning: START_INDEX (${startIndex}) is greater than the total number of accounts (${accounts.length}). No accounts will be processed.`);
    }
  }

  for (const [index, account] of accounts.entries()) {
    if (index + 1 < startIndex) {
      continue;
    }
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await runAccountFlow(page, account, index, accounts.length);
    } catch (error) {
      console.error(
        `[${index + 1}/${accounts.length}] Failed for ${account.username}: ${error.message}`
      );
      logFailure(account, error);
    } finally {
      if (index < accounts.length - 1 && !page.isClosed()) {
        await page.waitForTimeout(2_000);
      }

      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }
});
