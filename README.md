# 1xauto

This Playwright flow opens the official login page and signs in using credentials supplied locally. It runs with a visible browser so you can complete any CAPTCHA, OTP, or other account verification yourself.

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Run `npx playwright install chromium`.
4. Copy `.env.example` to `.env` and enter your account credentials. Add `ONEXBET_SURNAME` when your account is redirected to the location-verification form.
5. Run `npm run login`.

The `.env` file is ignored by Git and must not be committed.

After the Vodafone deposit window opens, the flow saves a clipped image with the site header and payment window to `screenshots/vodafone-deposit-<timestamp>.png`.

## Limits

The flow does not bypass CAPTCHAs, OTPs, or any other account security controls. It only performs normal browser login actions for an account you control.
