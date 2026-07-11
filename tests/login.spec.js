import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';

const loginUrl = 'https://eg1xbet.com/en/user/login';
const rechargeUrl = 'https://eg1xbet.com/en/office/recharge';
const accountVerificationUrl = /\/en\/user\/accountverify(?:[/?#]|$)/;
const accountsFilePath = path.resolve(process.cwd(), 'accounts.csv');
const failuresLogPath = path.resolve(process.cwd(), 'logs', 'failed-accounts.log');

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

  const screenshotTimestamp = new Date().toISOString().replace(/[:.]/g, '-');

  await page.screenshot({
    path: `screenshots/vodafone-deposit-${screenshotTimestamp}.png`,
    clip: {
      x: 0,
      y: 0,
      width: viewport.width,
      height: Math.ceil(modalBox.y + modalBox.height)
    }
  });
}

test('sign in to 1xBet', async ({ browser }) => {
  test.setTimeout(0);

  const accounts = getAccountsToProcess();
  console.log(`Loaded ${accounts.length} account(s) from accounts.csv`);

  if (!accounts.length) {
    throw new Error('No accounts available. Add rows to accounts.csv or set environment variables.');
  }

  for (const [index, account] of accounts.entries()) {
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
