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
import { emit } from '../lib/events.js';
import { attachMetrics } from '../lib/net-metrics.js';
import {
  PaymentDisabledError,
  isGateDisabled,
  markDisabled,
  markEnabled,
  matchesRestriction,
  readGate,
  markStillDisabled,
  reminderDue
} from '../lib/deposit-gate.js';
import { sendGateAlert } from '../lib/deposit-gate-notify.js';
import {
  SiteBlockedError,
  blockDue,
  markSiteBlocked,
  markSiteUnblocked,
  matchesSiteBlock,
  readSiteBlock
} from '../lib/site-block.js';
import { sendSiteBlockAlert, sendSiteUnblockedAlert } from '../lib/site-block-notify.js';

const loginUrl = 'https://eg1xbet.com/en/user/login';
const rechargeUrl = 'https://eg1xbet.com/en/office/recharge';
const accountVerificationUrl = /\/en\/user\/accountverify(?:[/?#]|$)/;
const accountsFilePath = path.resolve(process.cwd(), process.env.ACCOUNTS_FILE || 'accounts.csv');
// Defaults are the production paths. The overrides exist so the evidence guard
// can run the real flow without writing diagnostics into a live shard's tree.
const failuresLogPath = path.resolve(
  process.cwd(),
  process.env.FAILURES_LOG_FILE || path.join('logs', 'failed-accounts.log')
);
const errorShotsDir = path.resolve(
  process.cwd(),
  process.env.ERROR_SCREENSHOTS_DIR || path.join('screenshots', 'errors')
);
const debugShotsDir = path.resolve(
  process.cwd(),
  process.env.DEBUG_SCREENSHOTS_DIR || 'screenshots'
);
const stateFilePath = process.env.STATE_FILE || path.resolve(process.cwd(), 'state.json');
const runSummaryPath = process.env.RUN_SUMMARY_FILE || path.resolve(process.cwd(), 'run-summary.json');
// Gate evidence must live outside the shard screenshot dirs: the realtime
// sender scans those, parses a phone number out of the filename and posts it to
// the channel. A gate image there would be sent as if it were a payment.
const gateShotsDir = path.resolve(process.cwd(), process.env.GATE_SHOTS_DIR || path.join('screenshots', 'gate'));
const GATE_ENABLED = process.env.GATE_ENABLED !== 'false';
const GATE_PROBE = process.env.GATE_PROBE === 'true';
const SERVICE_NAME = process.env.SERVICE_NAME || 'local';
// Demo mode: process exactly these account indices (1-based) inside the range,
// skipping the rest without opening a browser. Used by scripts/run-demo.ps1 so
// the boss sees three known-good accounts instead of a full pass.
const DEMO_INDICES = process.env.DEMO_INDICES
  ? new Set(
      process.env.DEMO_INDICES.split(',')
        .map((value) => parseInt(value.trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  : null;
const screenshotCounts = new Map();
const uniqueNumbers = new Set();
let currentBatchId = null;

function emitStep(step, { account, phase, data } = {}) {
  emit({
    kind: 'step',
    step,
    account,
    phase,
    batch: currentBatchId || undefined,
    data
  });
}

// Saves a full-page screenshot at the moment of failure. Returns null when the
// page or browser is already gone, so the alert degrades to text instead of
// throwing inside the failure path.
async function captureErrorShot(page, { account, step }) {
  try {
    const dir = errorShotsDir;
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeAccount = String(account || 'unknown')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/01\d{9}/g, 'acct')
      .slice(0, 40);
    const safeStep = String(step || 'step')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/01\d{9}/g, 'step')
      .slice(0, 40);
    const file = path.join(dir, `${ts}-${safeAccount}-${safeStep}.png`);
    await page.screenshot({ path: file, fullPage: true, timeout: 5000 });
    return file;
  } catch {
    return null;
  }
}

// A full-page shot for the gate alert. Only taken when the payment cell already
// looks disabled, so the normal path never pays for it.
async function captureGateShot(page, kind) {
  try {
    mkdirSync(gateShotsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(gateShotsDir, `vodafone-${kind}-${ts}.png`);
    await page.screenshot({ path: file, fullPage: true, timeout: 5000 });
    return file;
  } catch {
    return null;
  }
}

// Reads every Vodafone cell. The site can render several variants (`r_1`,
// `r_2`, ...); gating on one disabled variant while another still works would
// pause the farm for nothing.
async function readVodafoneCells(scope, selector) {
  try {
    return await scope.locator(selector).evaluateAll((els) =>
      els.map((el) => ({
        id: el.id || '',
        disabled:
          el.getAttribute('data-disabled') === 'true' ||
          el.classList.contains('payment_item--disabled'),
        message: el.getAttribute('data-restrictionmessage') || ''
      }))
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// IP-level block: "Suspicious activity detected. Try again later."
// ---------------------------------------------------------------------------
// Unlike a bad password, this is not about the account. 1xbet serves the same
// modal to every login from this address, so the pass must stop at the first
// one, and the sibling shard must stop too — that is what the shared breaker
// file is for. Without it a single block burned 83 accounts in 22 minutes.

const SITE_BLOCK_TEXT = /suspicious activity|try again later/i;

// Returns the modal text, or null. Waits briefly because the modal appears
// right after the login POST.
async function readSiteBlockModal(page, { waitMs = 800 } = {}) {
  const probe = async (locator) => {
    if (waitMs > 0) {
      await locator.waitFor({ state: 'visible', timeout: waitMs });
    } else if (!(await locator.isVisible().catch(() => false))) {
      throw new Error('not visible');
    }
    const text = (await locator.textContent()) || '';
    return text.trim() || 'Suspicious activity detected. Try again later.';
  };

  const selectors = ['.alerts-text', '.alert__text', '[class*="alerts-text"]'];
  for (const selector of selectors) {
    try {
      return await probe(page.locator(selector).filter({ hasText: SITE_BLOCK_TEXT }).first());
    } catch {
      // try the next shape
    }
  }

  try {
    return await probe(page.getByText(SITE_BLOCK_TEXT).first());
  } catch {
    return null;
  }
}

// Records the block, alerts the admin once, and throws. The caller must not
// persist state for this account: it was never processed.
async function raiseSiteBlock({ page, account, reason, logger }) {
  const message =
    reason || (await readSiteBlockModal(page)) || 'Suspicious activity detected. Try again later.';
  const shot = await captureErrorShot(page, { account: account.username, step: 'site.blocked' });

  let result = null;
  try {
    result = markSiteBlocked({
      reason: message,
      account: account.username,
      shard: SERVICE_NAME,
      screenshot: shot
    });
  } catch (error) {
    logger.error(`could not write the site-block breaker: ${error.message}`, {
      account: account.username,
      phase: 'login'
    });
  }

  const blockedUntil = result?.block?.blockedUntil || null;
  emit({
    kind: 'site.blocked',
    account: account.username,
    phase: 'login',
    batch: currentBatchId || undefined,
    data: { reason: message, blockedUntil, shard: SERVICE_NAME, shot }
  });

  logger.warn(
    `1xbet is blocking this IP — farm parked${blockedUntil ? ` until ${blockedUntil}` : ''}`,
    { account: account.username, phase: 'login' }
  );

  if (result?.shouldAlert) {
    await sendSiteBlockAlert({ block: result.block, images: shot ? [shot] : [] }).catch((error) =>
      logger.error(`site-block alert failed: ${error.message}`, {
        account: account.username,
        phase: 'login'
      })
    );
  }

  throw new SiteBlockedError(message);
}

// Stops the pass, records the gate and alerts once. Always throws, so callers
// cannot accidentally continue into the number-extraction path.
async function raisePaymentGate({ page, account, depositFrame, gridShot, reason, logger }) {
  const shots = [];
  if (gridShot) shots.push(gridShot);

  try {
    const box = depositFrame.locator('#payment_modal_container');
    mkdirSync(gateShotsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const msgShot = path.join(gateShotsDir, `vodafone-disabled-message-${ts}.png`);
    await box.screenshot({ path: msgShot, timeout: 5000 });
    shots.push(msgShot);
  } catch {
    // The grid shot is enough if the modal is already gone.
  }

  if (!gridShot && page) {
    const fallback = await captureGateShot(page, 'disabled');
    if (fallback) shots.unshift(fallback);
  }

  let gate = null;
  let notify = false;
  if (GATE_ENABLED) {
    try {
      // In a probe the gate is already set: the point is only to record that
      // the wallet is still off (which advances the ladder) without firing a
      // second "disabled" alert.
      const result = GATE_PROBE
        ? markStillDisabled({ screenshots: shots })
        : markDisabled({
            reason: reason || 'This method is not available due to technical issues',
            account: account.username,
            shard: SERVICE_NAME,
            screenshots: shots
          });
      gate = result.gate;
      notify = GATE_PROBE ? false : result.notify;
    } catch (error) {
      logger.error(`could not write the deposit gate: ${error.message}`, {
        account: account.username,
        phase: 'payment'
      });
    }
  }

  if (notify && gate) {
    try {
      await sendGateAlert({ kind: 'disabled', gate, images: shots });
    } catch (error) {
      logger.error(`gate alert failed: ${error.message}`, { account: account.username, phase: 'payment' });
    }
  }

  // Per-probe heartbeat, admin only. It is sent from the probe (not the loop) so
  // it applies without restarting the long-lived run-loop. Skipped when the
  // 60-minute reminder is due, so the two never double up; a Telegram failure
  // must never fail the probe itself.
  if (GATE_PROBE && gate && gate.disabled && !reminderDue(gate)) {
    try {
      await sendGateAlert({ kind: 'still-down', gate });
    } catch (error) {
      logger.error(`still-down message failed: ${error.message}`, {
        account: account.username,
        phase: 'payment'
      });
    }
  }

  emit({
    kind: 'gate.disabled',
    account: account.username,
    phase: 'payment',
    batch: currentBatchId || undefined,
    data: { reason: reason || null, shard: SERVICE_NAME, shots, nextCheckAt: gate?.nextCheckAt || null }
  });

  logger.warn(`Vodafone deposit is disabled — gate set, stopping this pass`, {
    account: account.username,
    phase: 'payment'
  });

  throw new PaymentDisabledError();
}

const COUNTRY_CODE_INIT_SCRIPT = `(() => {
  let _v3 = null;
  Object.defineProperty(window, '__V3_HOST_APP__', {
    get() { return _v3; },
    set(val) {
      try {
        if (val && val.pinia && val.pinia.global && val.pinia.global.currentCountryCode !== 'eg' && location.pathname.includes('/recharge')) {
          console.log('[PATCH] countryCode ' + val.pinia.global.currentCountryCode + ' -> eg');
          val.pinia.global.currentCountryCode = 'eg';
        }
      } catch {}
      _v3 = val;
    },
    configurable: true
  });

  let _pc = null;
  Object.defineProperty(window, '__PAYMENT_CLIENT__', {
    get() { return _pc; },
    set(val) {
      try {
        if (val && val.pinia && val.pinia.global && val.pinia.global.currentCountryCode !== 'eg') {
          console.log('[PATCH-PAYMENT] countryCode ' + val.pinia.global.currentCountryCode + ' -> eg');
          val.pinia.global.currentCountryCode = 'eg';
        }
        if (val && val.config && val.config.public && val.config.public.currentCountryCode !== 'eg') {
          val.config.public.currentCountryCode = 'eg';
        }
      } catch {}
      _pc = val;
    },
    configurable: true
  });
})();`;

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

async function runAccountFlow(page, account, index, total, logger, ctx = { step: 'account.start' }) {
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

  await page.context().addInitScript(COUNTRY_CODE_INIT_SCRIPT);

  ctx.step = 'login.page_open';
  emitStep(ctx.step, { account: username, phase: 'login' });
  ctx.metrics?.setPhase('login');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  // The block modal can already be on the page before we type anything.
  const blockedOnLoad = await readSiteBlockModal(page, { waitMs: 0 });
  if (blockedOnLoad) {
    await raiseSiteBlock({ page, account, reason: blockedOnLoad, logger });
  }

  const loginInput = page.locator('input#username');
  const passwordInput = page.locator('input#username-password');
  const submitButton = page.locator('button.auth-form-fields__submit');

  await expect(loginInput).toBeVisible({ timeout: 30_000 });
  await expect(passwordInput).toBeVisible({ timeout: 30_000 });
  await expect(submitButton).toBeEnabled();

  await loginInput.fill(username);
  await passwordInput.fill(password);
  ctx.step = 'login.filled';
  emitStep(ctx.step, { account: username, phase: 'login' });

  await expect(submitButton).toBeVisible();
  ctx.step = 'login.submit';
  emitStep(ctx.step, { account: username, phase: 'login' });
  await submitButton.click();

  await page.waitForURL(
    (url) => !url.toString().includes('/user/login'),
    { timeout: 10_000 }
  ).catch(() => {});

  const currentUrl = page.url();
  const loginFormStillVisible = await loginInput.isVisible().catch(() => false);
  ctx.step = 'login.wait';
  emitStep(ctx.step, {
    account: username,
    phase: 'login',
    data: { url: currentUrl, stillOnLogin: loginFormStillVisible }
  });

  if (currentUrl.includes('/user/login') && loginFormStillVisible) {
    // The IP block looks like a login failure but is site-wide: say so, and
    // stop the farm rather than trying the next account. The modal can take
    // 40+ seconds to render under a hard block, so the fast snapshot is only
    // an optimization — the text check below is the reliable path.
    const blockedAfterSubmit = await readSiteBlockModal(page, { waitMs: 3_000 });
    if (blockedAfterSubmit) {
      await raiseSiteBlock({ page, account, reason: blockedAfterSubmit, logger });
    }

    const loginErrorHint = await page
      .locator('text=/incorrect|invalid|wrong|blocked|suspicious|banned/i')
      .first()
      .textContent({ timeout: 45_000 })
      .catch(() => '');

    // Whatever the markup, that phrase means the IP is blocked. Raising here
    // also covers a modal that appeared after the snapshot above.
    if (matchesSiteBlock(loginErrorHint)) {
      await raiseSiteBlock({ page, account, reason: loginErrorHint.trim(), logger });
    }

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

  const vodafoneSelector = '[id^="vodafone_"]';
  let scope = null;
  let paymentFrame = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      logger.info(`Vodafone option not ready, reloading recharge page (attempt ${attempt + 1})`, { account: username, phase: 'payment' });
    }

    ctx.step = 'payment.open';
    emitStep(ctx.step, { account: username, phase: 'payment', data: { attempt: attempt + 1 } });
    ctx.metrics?.setPhase('deposit');
    await page.goto(rechargeUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);

    const ccInfo = await page.evaluate(() => {
      const r = {};
      try { r.v3CC = window.__V3_HOST_APP__?.pinia?.global?.currentCountryCode; } catch {}
      try {
        const pc = window.__PAYMENT_CLIENT__;
        if (pc) {
          r.pcExists = true;
          r.pcKeys = Object.keys(pc).slice(0, 15);
          r.pcPiniaCC = pc?.pinia?.global?.currentCountryCode;
          r.pcConfigCC = pc?.config?.public?.currentCountryCode;
        } else {
          r.pcExists = false;
        }
      } catch (e) { r.pcErr = e.message; }
      return r;
    });
    logger.info(`CC check: ${JSON.stringify(ccInfo)}`, { account: username, phase: 'payment' });
    ctx.step = 'payment.cc_check';
    emitStep(ctx.step, {
      account: username,
      phase: 'payment',
      data: {
        pcExists: ccInfo.pcExists,
        countryCode: ccInfo.pcConfigCC || ccInfo.v3CC || null
      }
    });

    if (ccInfo.pcExists && ccInfo.pcConfigCC !== 'eg') {
      logger.info('Patching __PAYMENT_CLIENT__ country code via evaluate', { account: username, phase: 'payment' });
      await page.evaluate(() => {
        const pc = window.__PAYMENT_CLIENT__;
        if (pc?.config?.public) pc.config.public.currentCountryCode = 'eg';
        if (pc?.pinia?.global) pc.pinia.global.currentCountryCode = 'eg';
      });
    }

    if (!ccInfo.pcExists) {
      logger.info('Payment client not loaded, waiting 15s more...', { account: username, phase: 'payment' });
      await page.waitForTimeout(15000);
      const ccInfo2 = await page.evaluate(() => {
        const r = {};
        try {
          const pc = window.__PAYMENT_CLIENT__;
          if (pc) {
            r.pcExists = true;
            r.pcConfigCC = pc?.config?.public?.currentCountryCode;
            r.pcPiniaCC = pc?.pinia?.global?.currentCountryCode;
          }
        } catch {}
        return r;
      });
      logger.info(`CC check2: ${JSON.stringify(ccInfo2)}`, { account: username, phase: 'payment' });
      if (ccInfo2.pcExists && ccInfo2.pcConfigCC !== 'eg') {
        logger.info('Patching __PAYMENT_CLIENT__ country code (2nd attempt)', { account: username, phase: 'payment' });
        await page.evaluate(() => {
          const pc = window.__PAYMENT_CLIENT__;
          if (pc?.config?.public) pc.config.public.currentCountryCode = 'eg';
          if (pc?.pinia?.global) pc.pinia.global.currentCountryCode = 'eg';
        });
      }
    }

    let vodafoneFound = false;
    const searchDeadline = Date.now() + 30000;

    while (Date.now() < searchDeadline) {
      const mainCount = await page.locator(vodafoneSelector).count();
      if (mainCount > 0) {
        vodafoneFound = true;
        break;
      }

      for (const frame of page.frames()) {
        try {
          const count = await frame.locator(vodafoneSelector).count();
          if (count > 0) {
            paymentFrame = frame;
            vodafoneFound = true;
            break;
          }
        } catch {}
      }
      if (vodafoneFound) break;
      await page.waitForTimeout(1000);
    }

    if (!vodafoneFound) {
      const allIds = await page.evaluate(() => {
        return [...document.querySelectorAll('[id]')].map(el => el.id).filter(id => id.toLowerCase().includes('voda') || id.toLowerCase().includes('payment') || id.toLowerCase().includes('modal'));
      });
      logger.info(`Found IDs on page: ${JSON.stringify(allIds)}`, { account: username, phase: 'payment' });
      for (const frame of page.frames()) {
        try {
          const frameIds = await frame.evaluate(() => {
            return [...document.querySelectorAll('[id]')].map(el => el.id).filter(id => id.toLowerCase().includes('voda') || id.toLowerCase().includes('payment') || id.toLowerCase().includes('modal'));
          });
          if (frameIds.length) logger.info(`Found IDs in frame: ${JSON.stringify(frameIds)}`, { account: username, phase: 'payment' });
        } catch {}
      }
      mkdirSync(debugShotsDir, { recursive: true });
      await page.screenshot({ path: path.join(debugShotsDir, `debug-deposit-${index + 1}-${attempt + 1}.jpg`), type: 'jpeg', quality: 80, fullPage: true });
      if (attempt === 2) {
        throw new Error('Vodafone option ([id^="vodafone_egypt_webdefault_"]) not found within 3 attempts.');
      }
      continue;
    }

    scope = paymentFrame || page;
    break;
  }

  const depositFrame = page.frameLocator(
    'iframe[src*="/paysystems/deposit/"]'
  );

  // The alert text also exists in the disabled grid; only a visible alert is a
  // message. Reading it twice (now and after the modal settles) covers the
  // moment between the window opening and the message being rendered.
  const readAlertText = async () => {
    const box = depositFrame.locator('#payment_modal_container .alerts-text').first();
    const visible = await box.isVisible().catch(() => false);
    if (!visible) return '';
    return (await box.textContent().catch(() => '')) || '';
  };

  // The site marks a disabled method on the cell itself. Reading the flag costs
  // nothing and lets the alert carry a photo of the greyed option even if the
  // click never opens a window. The modal content below is still the deciding
  // signal, so a stale attribute cannot pause the farm by itself.
  const cellState = await readVodafoneCells(scope, vodafoneSelector);
  const allCellsDisabled = cellState.length > 0 && cellState.every((cell) => cell.disabled);
  let gridShot = null;

  if (allCellsDisabled) {
    const message = cellState.find((cell) => cell.message)?.message || '';
    logger.info(
      `Vodafone cells report disabled (${cellState.map((c) => c.id).filter(Boolean).join(', ') || 'no id'})${message ? `: ${message}` : ''}`,
      { account: username, phase: 'payment' }
    );
    gridShot = await captureGateShot(page, 'disabled');
  }

  try {
    await scope.locator(vodafoneSelector).first().click();
    await depositFrame.locator('#payment_modal_container').waitFor({ timeout: 15_000 });
  } catch (error) {
    // No window at all (or the disabled cell refused the click), but every cell
    // says disabled: this is the gate, not a slow page. Anything else stays a
    // normal, retryable failure.
    if (allCellsDisabled) {
      await raisePaymentGate({
        page,
        account,
        depositFrame,
        gridShot,
        reason: cellState.find((cell) => cell.message)?.message || '',
        logger
      });
    }
    throw error;
  }

  const earlyAlert = await readAlertText();
  if (matchesRestriction(earlyAlert)) {
    await raisePaymentGate({
      page,
      account,
      depositFrame,
      gridShot,
      reason: earlyAlert.trim(),
      logger
    });
  }

  ctx.step = 'payment.modal';
  emitStep(ctx.step, { account: username, phase: 'payment' });
  ctx.metrics?.setPhase('modal');
  await page.waitForTimeout(2_000);

  const alertText = await readAlertText();
  if (matchesRestriction(alertText)) {
    await raisePaymentGate({
      page,
      account,
      depositFrame,
      gridShot,
      reason: alertText.trim(),
      logger
    });
  }

  const paymentModal = depositFrame.locator('#payment_modal_container');
  const modalBox = await paymentModal.boundingBox();
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));

  if (!modalBox) {
    throw new Error('Could not determine the Vodafone payment window position.');
  }

  const modalText = await paymentModal.textContent().catch(() => '');
  const extractedNumber = extractPhoneNumber(modalText);

  let finalScreenshotPath;
  if (extractedNumber) {
    logger.info(`extracted mobile number ${extractedNumber}`, { account: username, phase: 'payment' });
    ctx.step = 'payment.read_number';
    emitStep(ctx.step, { account: username, phase: 'payment', data: { number: extractedNumber } });
    uniqueNumbers.add(extractedNumber);
    
    let count = screenshotCounts.get(extractedNumber) || 0;
    count += 1;
    screenshotCounts.set(extractedNumber, count);

    finalScreenshotPath = buildScreenshotPath(extractedNumber, count, (candidatePath) => existsSync(candidatePath));
  } else {
    logger.warn('Egyptian mobile number matching (01\\d{9}) not found in the payment modal.', { account: username, phase: 'payment' });
    ctx.step = 'payment.read_number';
    emitStep(ctx.step, { account: username, phase: 'payment', data: { number: null } });
    const screenshotTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    finalScreenshotPath = fallbackScreenshotPath(screenshotTimestamp);
  }

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
  ctx.step = 'shot.saved';
  emitStep(ctx.step, {
    account: username,
    phase: 'payment',
    data: { shot: finalScreenshotPath, number: extractedNumber || null }
  });
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
      const ctx = { step: 'account.start' };
      // Opt-in byte accounting (NET_METRICS=true). Returns null when disabled,
      // so the production path is unchanged.
      ctx.metrics = await attachMetrics(page, {
        account: account.username,
        shard: process.env.SERVICE_NAME || 'local'
      });
      try {
        return await runAccountFlow(page, account, index, total, logger, ctx);
      } catch (error) {
        // A disabled wallet is not a broken account: it must not produce an
        // error screenshot or a step.failed event, and it must not retry.
        const isGate = error?.code === 'PAYMENT_METHOD_DISABLED';
        const shot = isGate ? null : await captureErrorShot(page, { account: account.username, step: ctx.step });
        if (!isGate) {
          emit({
            kind: 'step.failed',
            step: ctx.step,
            account: account.username,
            phase: 'account',
            batch: currentBatchId || undefined,
            data: { error: error.message, shot: shot || undefined }
          });
        }
        throw error;
      } finally {
        try {
          ctx.metrics?.detach();
        } catch {
          // metrics must never fail an account
        }
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

// Optional request blocking, off unless BLOCK_HOSTS is set. Exists so a
// measurement run can prove what a blocklist would cost in bytes and pixels;
// production shards leave it unset.
const BLOCK_HOSTS = (process.env.BLOCK_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

async function newAccountContext(browser, proxy) {
  const context = await browser.newContext(proxy ? { proxy } : {});
  if (!BLOCK_HOSTS.length) return context;

  await context.route('**/*', (route) => {
    let host = '';
    try {
      host = new URL(route.request().url()).host.toLowerCase();
    } catch {
      return route.continue();
    }
    const blocked = BLOCK_HOSTS.some((b) => host === b || host.endsWith(`.${b}`));
    return blocked ? route.abort() : route.continue();
  });
  return context;
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
  currentBatchId = batchId;
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
  if (GATE_PROBE) {
    logger.info('gate probe pass: one account, no state persistence');
  }

  let gatedOut = false;
  let blockedOut = false;

  for (const [index, account] of accounts.entries()) {
    if (index + 1 < startIndex) {
      continue;
    }
    if (index + 1 > endIndex) {
      logger.info(`end index reached at ${endIndex}; stopping this shard.`);
      break;
    }
    if (DEMO_INDICES && !DEMO_INDICES.has(index + 1)) {
      continue;
    }

    // Another shard may have set the gate while this account was in flight.
    // Stop before opening a browser: the check is a single file read.
    if (!GATE_PROBE && GATE_ENABLED && isGateDisabled()) {
      const gate = readGate();
      logger.warn(
        `deposit gate is set (${gate.reason || 'vodafone disabled'}) — stopping pass before account #${index + 1}; next check ${gate.nextCheckAt}`
      );
      emit({
        kind: 'gate.skip',
        phase: 'account',
        batch: currentBatchId || undefined,
        data: { index: index + 1, nextCheckAt: gate.nextCheckAt }
      });
      gatedOut = true;
      break;
    }

    // Another shard may have hit the IP wall while this account was in flight.
    // Stop before opening a browser: the check is a single file read. Once the
    // wait has expired we do try one account — that is how recovery is proved.
    const block = readSiteBlock();
    if (block.blocked && !blockDue(block)) {
      logger.warn(
        `1xbet is blocking this IP (${block.reason || 'suspicious activity'}) — stopping pass before account #${index + 1}; retry ${block.blockedUntil}`
      );
      emit({
        kind: 'site.skip',
        phase: 'account',
        batch: currentBatchId || undefined,
        data: { index: index + 1, blockedUntil: block.blockedUntil }
      });
      blockedOut = true;
      break;
    }

    const startedAt = Date.now();
    const result = await runAccountFlowWithRetry(
      () => newAccountContext(browser, proxy),
      account,
      index,
      accounts.length,
      {
        maxRetries,
        logger,
        // A probe must not move the shard's saved position, and a gate stop is
        // not a processed account.
        onSuccess: () => {
          if (!GATE_PROBE) persistState(index + 1);
        },
        onFailure: (outcome) => {
          // A gate stop and an IP block are not processed accounts: advancing
          // the shard state for them would make the next pass skip a real one.
          if (
            GATE_PROBE ||
            outcome?.category === 'paymentDisabled' ||
            outcome?.category === 'siteBlocked'
          ) {
            return;
          }
          persistState(index + 1);
        }
      }
    );
    const elapsedMs = Date.now() - startedAt;

    // Site-wide wall: raiseSiteBlock already recorded it, alerted and stopped
    // the sibling shards. Do not count this account as failed.
    if (result.outcome === 'failure' && result.category === 'siteBlocked') {
      logger.warn(`pass stopped: 1xbet is blocking this IP (account ${account.username})`);
      emit({
        kind: 'site.pass.stopped',
        phase: 'account',
        batch: currentBatchId || undefined,
        data: { processed: runResults.length, reason: result.error?.message || 'SITE_BLOCKED' }
      });
      blockedOut = true;
      break;
    }

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
      emit({
        kind: 'account.done',
        account: account.username,
        phase: 'account',
        batch: currentBatchId || undefined,
        data: { ms: elapsedMs, retries: result.retries, numbers: result.value ? 1 : 0 }
      });
      if (result.value) {
        screenshots.push(result.value);
      }

      // The first successful login after a block proves the IP is accepted
      // again. This is the only thing that clears the breaker.
      if (readSiteBlock().blocked) {
        const unblocked = markSiteUnblocked({ account: account.username, shard: SERVICE_NAME });
        if (unblocked.changed) {
          logger.info('1xbet is accepting logins again — clearing the site block');
          emit({
            kind: 'site.unblocked',
            account: account.username,
            phase: 'account',
            batch: currentBatchId || undefined,
            data: { recoveredAt: unblocked.block.recoveredAt }
          });
          await sendSiteUnblockedAlert({ block: unblocked.block }).catch((error) =>
            logger.error(`site-unblocked alert failed: ${error.message}`, {
              account: account.username,
              phase: 'account'
            })
          );
        }
      }

      // Self-healing: the probe (or any account) that produces a number is the
      // proof that the wallet is back. A numberless "success" is the old
      // 0-output path (fallback screenshot), so it must not clear the gate.
      const producedNumber = result.value ? /01\d{9}/.test(path.basename(result.value)) : false;
      if (GATE_ENABLED && producedNumber && isGateDisabled()) {
        const restored = markEnabled({
          account: account.username,
          shard: SERVICE_NAME,
          screenshot: result.value || null
        });
        if (restored.changed) {
          logger.info('vodafone deposit is back — clearing the gate');
          emit({
            kind: 'gate.enabled',
            account: account.username,
            phase: 'account',
            batch: currentBatchId || undefined,
            data: { since: restored.gate.since, restoredAt: restored.gate.restoredAt }
          });
          if (restored.notify) {
            await sendGateAlert({
              kind: 'enabled',
              gate: restored.gate,
              images: result.value ? [result.value] : []
            }).catch((error) => logger.error(`gate restore alert failed: ${error.message}`, {
              account: account.username,
              phase: 'account'
            }));
          }
        }
      }
    } else if (result.category === 'paymentDisabled') {
      // raisePaymentGate already recorded the state and sent the alert.
      logger.warn(`pass stopped: Vodafone deposit is disabled (account ${account.username})`);
      gatedOut = true;
      break;
    } else {
      logger.error(
        `failed for ${account.username}: ${result.error.message}`,
        { account: account.username, phase: 'account' }
      );
      emit({
        kind: 'account.failed',
        account: account.username,
        phase: 'account',
        batch: currentBatchId || undefined,
        data: {
          error: result.error.message,
          category: result.category,
          retries: result.retries,
          ms: elapsedMs
        }
      });
      logFailure(account, result.error);
    }

    if (index < accounts.length - 1) {
      const configured = parseInt(process.env.ACCOUNT_DELAY_MS, 10);
      const delayMs = Number.isFinite(configured) && configured >= 0 ? configured : 2_000;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (gatedOut) {
    logger.warn('pass stopped early: Vodafone deposit is disabled');
    emit({
      kind: 'gate.pass.stopped',
      phase: 'account',
      batch: currentBatchId || undefined,
      data: { processed: runResults.length }
    });
  }

  if (blockedOut && !gatedOut) {
    logger.warn('pass stopped early: 1xbet is blocking this IP');
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
