import { test, expect } from '@playwright/test';

const loginUrl = 'https://eg1xbet.com/en/user/login';
const rechargeUrl = 'https://eg1xbet.com/en/office/recharge';
const accountVerificationUrl = /\/en\/user\/accountverify(?:[/?#]|$)/;

test('sign in to 1xBet', async ({ page }) => {
  const username = process.env.ONEXBET_USERNAME;
  const password = process.env.ONEXBET_PASSWORD;
  const surname = process.env.ONEXBET_SURNAME;

  if (!username || !password) {
    throw new Error(
      'Set ONEXBET_USERNAME and ONEXBET_PASSWORD in your environment or .env file.'
    );
  }

  if (surname && password === surname) {
    throw new Error(
      'ONEXBET_PASSWORD and ONEXBET_SURNAME must contain different values.'
    );
  }

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

  // The flow intentionally stops before entering payment details or confirming a deposit.
});
