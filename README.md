# 1xauto

This Playwright flow opens the official 1xBet login page, signs in with one or more accounts, and reaches the recharge/deposit flow so a screenshot can be captured from the Vodafone payment window. It runs with a visible browser so you can handle any CAPTCHA, OTP, or account verification step manually if needed.

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Run `npx playwright install chromium`.
4. Create a local `.env` file from `.env.example` and set your fallback credentials:
   - `ONEXBET_USERNAME`
   - `ONEXBET_PASSWORD`
   - `ONEXBET_SURNAME` (only needed if the site asks for account verification)
5. Optionally create an `accounts.csv` file in the project root for batch processing. The script reads rows from it automatically if present.
6. Run `npm run login`.

The `.env` file is ignored by Git and must not be committed.

## Account Input Options

### Option 1: Use environment variables
If `accounts.csv` is missing or empty, the script falls back to the values in `.env`.

### Option 2: Use `accounts.csv`
Create a file named `accounts.csv` with this format:

```csv
username,password,surname
account1@example.com,account1password,Smith
account2@example.com,account2password,Johnson
```

Each row is processed in order. The script opens a fresh browser context for each account so one login session does not leak into the next.

## What the Flow Does

For each account, the script:
1. Opens the login page.
2. Fills in the username and password.
3. Handles the optional account verification screen if the site requests it.
4. Navigates to the recharge/deposit page.
5. Opens the Vodafone payment option inside the embedded payment iframe.
6. Captures a screenshot of the deposit window to `screenshots/vodafone-deposit-<timestamp>.png`.

## Logging and Failures

If an account fails, the script logs the error to `logs/failed-accounts.log` and continues with the next account instead of stopping the whole batch.

## Output Files

- Screenshots: `screenshots/`
- Playwright artifacts: `test-results/`
- Failed account log: `logs/failed-accounts.log`

## Limits

The flow does not bypass CAPTCHAs, OTPs, or any other account security controls. It only performs normal browser login actions for accounts you control.
