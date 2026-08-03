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

### Resuming or Starting from a Specific Record

To start or resume execution from a specific record (1-based record index, where 1 is the first record), set the `START_INDEX` environment variable before running the script:

- **Windows PowerShell:**
  ```powershell
  $env:START_INDEX=50; npm run login
  ```
- **Windows Command Prompt:**
  ```cmd
  set START_INDEX=50 && npm run login
  ```
- **macOS / Linux:**
  ```bash
  START_INDEX=50 npm run login
  ```

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
- Combined excel (unique numbers across all shards/loops): `extracted_numbers-combined.xlsx`
- Dedup ledger: `seen-numbers.json` (every number that has ever been reported)

## 24/7 Batch Automation (Azure VM)

The repo ships with scripts to run the batch loop 24/7 on a VM as parallel shards:

- `scripts/vm-setup.sh` — one-time VM provisioning (install node, chromium, deps).
- `scripts/register-shards.sh` — registers each shard as a systemd service:
  `SHARDS="1:149,150:276" COOLDOWN_MINUTES=60 sudo bash scripts/register-shards.sh`
- `run-loop.js` — endless loop: `scheduled-run.mjs` (login → excel → notify), then sleeps the cooldown.
- `scripts/scheduled-run.mjs` — runs `npm run login`, `npm run excel`, `node scripts/notify.js`.
- `scripts/notify.js` — sends the Telegram summary, only screenshots whose numbers are **new** (claimed from the shared `seen-numbers.json` ledger, cross-shard and cross-loop), and the combined deduped excel.
- `scripts/status.mjs` — dashboard: `node scripts/status.mjs` shows RAM/CPU/disk, service state, per-shard loop status (`loop-status-shard-1.json` / `-2.json`), unique-number count, and recent log lines.

Per-shard env (set by `register-shards.sh`):
`START_INDEX`, `END_INDEX`, `STATE_FILE`, `SCREENSHOTS_DIR`, `RUN_SUMMARY_FILE`, `EXCEL_FILE`, `STATUS_FILE`, `COOLDOWN_MINUTES`. The ledger is shared: both shards use the same `SEEN_NUMBERS_FILE`/`SEEN_NUMBERS_LOCK`, so a number is sent to Telegram exactly once.

### Telegram notifications

Set in `.env`:
- `TELEGRAM_BOT_TOKEN` — token from @BotFather.
- `TELEGRAM_CHAT_ID` — chat or channel id.

**Using a Telegram channel** (recommended over a private chat so you keep history):
1. Create a public/private channel in Telegram.
2. Add your bot as an **administrator** of the channel (so it can post).
3. Send any message to the channel (e.g. `/start` or a test message).
4. Get the numeric channel id from @userinfobot or `https://api.telegram.org/bot<TOKEN>/getUpdates` (it appears as `"chat":{"id":-100...}`).
5. Set that id as `TELEGRAM_CHAT_ID`.

### Posting to a channel for subscribers

To push the screenshots (and the combined excel) to a public channel so subscribers see them:
1. Create a channel (public or private).
2. Add the bot as an **administrator** with **Post Messages** permission.
3. Get the channel id (it starts with `-100`): forward a channel message to @userinfobot, or while the bot is the admin run `https://api.telegram.org/bot<TOKEN>/getUpdates` after posting a test message.
4. Set `TELEGRAM_CHANNEL_ID=-100...` in `.env` on the VM.
5. Restart the shards: `sudo systemctl restart 1xauto-shard-1 1xauto-shard-2`.

When `TELEGRAM_CHANNEL_ID` is set, each new screenshot and the combined excel are sent to **both** your private chat and the channel. Subscribers can then view the screens.

### Making the `/status` bot private

The bot already only answers chats listed in `STATUS_ALLOWED_IDS` (default: `TELEGRAM_CHAT_ID`), so strangers get nothing. For an extra lock, set a passcode in `.env` on the VM:

```
STATUS_PASSCODE=your-secret-word
```

Then `/status` alone is denied and only `/status your-secret-word` works. Restart with `sudo systemctl restart 1xauto-status-bot`.

### Monthly cost alerts (Azure)

Azure-native budgets (no code needed) email you before a cost threshold is hit:
1. Portal → your subscription → **Cost Management** → **Budgets** → **+ Add**.
2. Set a monthly amount (e.g. the VM SKU cost) and a threshold (e.g. 80% and 100%).
3. Add action groups with your email; you'll get notifications when the budget is consumed.

### Monitoring

- `node scripts/status.mjs` on the VM gives a live health snapshot.
- `journalctl -u 1xauto-shard-1 -f` / `journalctl -u 1xauto-shard-2 -f` tail live logs.
- `systemctl status 1xauto-shard-*` shows service state (auto-restarts on failure).

### Telegram `/status` command

A small bot service (`1xauto-status-bot`, from `scripts/status-bot.mjs`) long-polls Telegram and answers when you message the bot:

- Send `/status` to the bot → it replies with the full health snapshot (system, services, loops, ledger, recent logs).
- Send `/help` → lists commands.

Setup: `register-shards.sh` creates the service automatically. It only answers chats in `STATUS_ALLOWED_IDS` (comma-separated); if unset it falls back to `TELEGRAM_CHAT_ID`, so your own chat works out of the box. Start it with `sudo systemctl restart 1xauto-status-bot`, watch with `journalctl -u 1xauto-status-bot -f`.

## Limits

The flow does not bypass CAPTCHAs, OTPs, or any other account security controls. It only performs normal browser login actions for accounts you control.
