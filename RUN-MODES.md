# Run Modes

All commands run from the repo root (`C:\Users\Dell\Desktop\workspace\1xauto`).

## Windows: start and stop the whole pipeline

Double-click, or run from a terminal:

```
start-all.bat              fresh pass at each shard's range start
start-all.bat -Resume      continue each shard where it last was
start-all.bat -Restart     stop a running pipeline, then start
stop-all.bat               stop everything
```

`start-all.bat` starts shard-1, shard-2 and melbet (each batch starts its own
realtime sender and stops it afterwards), the Telegram ledger sync, and the
monitor supervisor that keeps the agent and the status bot alive.

Press **Q** in that window to stop everything. **Ctrl+C** and closing the
window also stop everything: the children run in a Windows job object with
kill-on-close, so they cannot outlive the console. `stop-all.bat` is for when
the window is gone — it also closes that window if it is still open, so you
never end up with a stray "exited with code 1" console.

If a pipeline is already running, `start-all.bat` refuses and lists what it
found instead of starting a second copy.

### Headed variants — same services, browsers on screen

```
start-all-headed.bat              whole farm: shard-1 + shard-2 + melbet (one browser each) + sync + monitor
start-all-headed.bat -Resume      continue where each shard stopped
start-all-headed.bat -Restart     replace a running pipeline
start-all-headed.bat -AccountDelayMs 15000    slower pacing when RAM is tight

shard-1-headed.bat                one shard alone, visible browser
shard-2-headed.bat -Resume        one shard alone, continue where it stopped
melbet-headed.bat                 melbet alone, visible browser
```

The shard bats refuse while the farm is running (`stop-all.bat` first); a second
copy of a shard would scrape the same accounts into the same ledger. They start
no ledger sync and no monitor — that is `start-all-headed.bat`'s job. Press **Q**
to stop.

Headed costs RAM: three visible Chromium trees on 8 GB is near the ceiling. Close
other browsers before starting the farm, or raise `-AccountDelayMs`.

## Environment rules

- `.env` **overrides** terminal variables (playwright config loads it with `override: true`). To run **headed** one-shot runs, set `HEADLESS=false` in `.env`.
- An explicit `HEADLESS` from the launcher still wins over `.env` (both 1xbet and melbet configs re-apply it after loading `.env`). That is what makes the headed bats work. Melbet also re-applies an explicit `ACCOUNT_DELAY_SECONDS`, so the live demo's 20 s pacing is not replaced by `.env`'s 0.
- The **loop** ignores `.env`'s `HEADLESS`; it is controlled by the `HEADED` terminal flag (unset = headless). `HEADED=true` forces headed mode end-to-end, overriding `.env`.
- `ALLOW_LIVE_RUN=true` is already in `.env`. Live execution is blocked without it.
- Loop runs only start a new batch after `COOLDOWN_MINUTES` (default 10). Stop a loop with `Ctrl+C`.

## Quick reference

| Mode | Command | Extra settings |
|---|---|---|
| Headed, one run | `npm run login` | `.env` `HEADLESS=false` |
| Headless, one run | `npm run login` | `.env` `HEADLESS=true` |
| Headed loop | `$env:HEADED = "true"; npm run loop` | (forces headed; `.env` not needed) |
| Headless loop | `npm run loop` | (default) |
| Any mode, start from index N | add `$env:START_INDEX = "N"` | also `$env:END_INDEX = "M"` to cap |

## 0. Boss demo — 3 accounts, live dashboard, real channel

```powershell
.\demo.bat
# or: powershell -NoProfile -File scripts\run-demo.ps1 -Indices 245,247,252 -DelayMs 15000
```

It refuses to start while the IP breaker is armed, pauses the farm, opens the
control room at `http://127.0.0.1:8787/`, runs three known-good accounts in a
visible browser, then waits for Enter and restores shard-2 (resume, 10 s
pacing). `.\demo.bat -NoRestart` leaves the farm stopped.

The demo uses the real ledger and the real Telegram channel. Numbers already in
the ledger show as **already seen** and are not resent — that is dedup working,
not a failure. Talk track: `demo/script.md`.

Demo-only switches (`DEMO_INDICES`, headed mode, screenshots/state paths) are
stripped by `scripts/launch-shard.ps1`, so a demo can never reshape the
production shard it restarts.

## 0a. Fleet demo — 1 shard vs 3 shards (2 × 1xbet + melbet)

```powershell
.\fleet-demo.bat
# or: powershell -NoProfile -File scripts\run-fleet-demo.ps1
```

Pauses the farm and opens the fleet control room at `http://127.0.0.1:8787/`.
It runs 1xbet shard-1 (`1,2,3`) alone until two accounts finish (max 110 s), so
the screen records a real 1‑shard rate, then adds melbet (`1,2`) and 1xbet
shard-2 (`245,247,252`). The two 1xbet shards use the real sender and the real
channel. Melbet runs extract-only: its ledger is far behind the shared one, so
attaching its sender would re-post history.

The dashboard shows per-shard progress, merged events, a measured 1-vs-3
throughput strip, and the same CPU/RAM/browser counters as Task Manager. The
grey bar is the rate recorded while only one shard ran; the blue bar is the
measured sum of all three now. They converge on ~3× when all three are warm.

Defaults: solo phase waits for two shard-1 completions (max 110 s), 20 s pacing
per 1xbet shard (10 s aggregate), 10 s stagger before shard-2, melbet 20 s.
Override with `-IndicesS1`, `-IndicesS2`,
`-DelayMs`, `-MelbetStart`, `-MelbetEnd`, `-MelbetDelaySec`, `-SoloSeconds`,
`-Port`, `-NoOpen`, `-NoWait`, `-NoRestart`, `-SkipPause`.

Melbet's `extracted_numbers-1.xlsx` is backed up and restored. Its demo
screenshots are moved to `screenshots\fleet-demo-<timestamp>` so a later melbet
sender cannot re-post them. Press **Enter** to restore shard-2 (resume, 10 s
pacing) + sync + monitor. `-NoRestart` leaves the farm stopped.

## 0b. Live demo — control panel, live resources, dial → Telegram time

```powershell
.\live-demo.bat
# or: node scripts\live-demo.mjs --port 8788 --open
```

Opens a control panel (default `http://127.0.0.1:8788/`; it steps to the next
port if 8788 is busy). Unlike `fleet-demo.bat`, nothing starts by itself: you
click **Start browser** on 1xbet shard 1, watch the laptop resources, then start
the rest. The panel controls eight services:

| id | service | launcher |
| --- | --- | --- |
| `demo-s1`, `demo-s2` | 1xbet shards 1 and 2 | `scripts/demo-shard.ps1` |
| `melbet` | Melbet | `scripts/demo-melbet.ps1` |
| `betjam` | BetJam | `scripts/demo-service.ps1` |
| `fastpari` | FastPari | `scripts/demo-service.ps1` |
| `lilbet` | Lilbet | `scripts/demo-service.ps1` |
| `linebet` | Linebet | `scripts/demo-service.ps1` |
| `paripulse` | PariPulse | `scripts/demo-service.ps1` |

Each can be started or stopped alone. **Start 5 autologins** queues just the five
external services; **Start all services** queues every one. Both run at most
**three** at a time and promote the next service as a slot frees up: eight headed
Chromium trees do not fit in 8 GB. The queue and current `running n/8` are shown
in the header; a queued card can be cancelled. **Stop all** ends the demo and
clears the queue; **Restore farm** brings the headless production farm back.

Every start runs that service's **full** account list, not a sample: 1xbet
shard 1 = accounts 1–149, shard 2 = 150–276, melbet = 1–271, BetJam / FastPari
/ PariPulse = 1–276, Linebet = 1–130, Lilbet = 1–278. Each pass therefore lasts
hours at the 20 s per-account pacing, and the queue cap above still applies.

Because of that cap, a full pass will not finish during the meeting. The practical
way to show every brand is: **Start all services**, let the first three show a
dial each (about a minute), then click **Stop browser** on those three. The next
three queued services start within a second, and so on. Each card's footer shows
`n done` against its range, and `Delivered` counts the dials that reached the
admin chat. **Stop all** at the end.

Lilbet's autologin repo only carries one row in `accounts.csv`; the demo sets
`ACCOUNTS_FILE` to `lilbet-autoreg/accounts.csv`, which holds the full list of
278 registered accounts. Production keeps using the repo's own CSV.

What the panel shows:

- live system CPU/RAM (the same totals Task Manager shows) plus per-service
  CPU/RAM/browser count measured from each service's process tree
- a measured **1 service vs fleet** strip: peak CPU and RAM while one service ran
  alone, then while several ran together
- for every dial: capture → Telegram latency, first-delivery time after session
  start, average/max latency, and unique-dial rate
- a screenshot wall that grows as dials land; the same files are hard-linked into
  `demo\live`, so one Explorer window fills up during the meeting
  (**Open screenshots folder**)

The demo is production-safe: it uses `demo/seen-numbers-demo.json` (reset at the
start of each session, so every dial is new for the sender), its own state,
screenshots (`screenshots\<service>`) and browser cache, and
`TELEGRAM_CHANNEL_ID=off` so dials go to the admin chat only, never the public
channel. `scripts/demo-service.ps1` points the five external repos at the same
demo tree through `SCREENSHOTS_DIR`, `STATE_FILE`, `RUN_SUMMARY_FILE`,
`EXCEL_FILE` and `BROWSER_CACHE_DIR`; their production defaults are unchanged.
Each service gets its own instance of the 1xauto realtime sender, so every dial
is posted to the admin chat and recorded in `events/` for the latency KPIs.
Melbet's `extracted_numbers-1.xlsx` is backed up once (never overwritten from a
possibly dirty demo file) and restored on stop, even if the demo is stopped hard.

The external repos were already Windows/headed-capable; four small
default-preserving patches make them demo-safe: `BROWSER_CACHE_DIR` in all five
Playwright configs, `SCREENSHOTS_DIR`/`EXCEL_FILE` in BetJam, and
`SCREENSHOTS_DIR`/`NUMBERS_JSON_FILE`/`EXCEL_FILE`/`RUN_SUMMARY_FILE` in
Linebet. Lilbet's inline Telegram step is skipped when `SKIP_NOTIFY=true`
because the panel's sender delivers the screenshots.

The farm must be paused first; the panel refuses to start while a production
shard pid is alive. Close the headed browsers before restoring the farm. Three
visible Chromium trees on 8 GB is near the ceiling — the panel shows free RAM
so you can see the spike, but do not leave them running afterwards.

## 1. Headed (single run) — watch it work

```powershell
# .env must contain: HEADLESS=false
npm run login
```

## 2. Headed loop — watch repeated batches

```powershell
$env:HEADED = "true"
npm run loop
```

## 3. Headless loop — default farm behavior

```powershell
npm run loop
```

Each iteration runs: `login` (extract numbers) → `excel` → `notify` (Telegram).

## 4. Start from a specific index

Works for every mode above — set `START_INDEX` before the command:

```powershell
# one run from account 50
$env:START_INDEX = "50"
npm run login

# headless loop from account 50
$env:START_INDEX = "50"
npm run loop

# headed loop from account 50
$env:START_INDEX = "50"; $env:HEADED = "true"
npm run loop
```

For one-shot runs an explicit `START_INDEX` wins over the saved state
(`state.json`). A loop restarts at `START_INDEX` on every batch.

Limit the range (useful on the laptop):

```powershell
$env:START_INDEX = "1"; $env:END_INDEX = "10"
```

## Laptop stability tips

```powershell
$env:PER_ACCOUNT_BROWSER = "true"   # fresh browser per account; contains crashes
$env:LOW_MEMORY = "true"            # --single-process --disable-gpu (headless only)
$env:SKIP_NOTIFY = "true"           # don't post to Telegram from the laptop
```

- `PER_ACCOUNT_BROWSER=true` is recommended for any local run — it isolates each
  account into its own browser process, so a crash only costs that account.
- `LOW_MEMORY=true` is only safe in headless mode; `--single-process` is
  crash-prone when a window is shown.
- `SKIP_NOTIFY=true` keeps local test runs from duplicating the VMs' posts to
  the Telegram channel.
- Close memory-heavy apps (Edge etc.) before running locally.

## One-off steps (run by the loop automatically)

```powershell
npm run excel   # rebuild extracted_numbers.xlsx from screenshots
npm run notify  # send numbers to Telegram
```
