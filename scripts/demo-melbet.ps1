# demo-melbet.ps1
# The headed melbet shard for the live demo. Started by scripts/live-demo.mjs.
#
# * demo ledger: every captured number is new for the demo, so the realtime
#   sender delivers it instead of skipping it as already-seen
# * Telegram channel disabled (TELEGRAM_CHANNEL_ID=off): dials go to the admin
#   chat only, never to the public channel
# * runs Playwright directly (not scheduled-run.mjs) so START_INDEX/END_INDEX
#   mean what they say: scheduled-run ignores them and walks the whole CSV
# * melbet's extracted_numbers-<start>.xlsx is backed up and restored, because
#   its spec overwrites the file in place

param(
    [int]$Start = 1,
    [int]$End = 271,
    [int]$DelaySec = 20
)

$ErrorActionPreference = 'Stop'
$ws = 'C:\Users\Dell\Desktop\workspace\1xauto'
$melbet = 'C:\Users\Dell\Desktop\workspace\melbet-autologin'
$demo = Join-Path $ws 'demo'

New-Item -ItemType Directory -Force -Path $demo | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ws 'logs') | Out-Null
Set-Location $melbet

$xlsx = Join-Path $melbet "extracted_numbers-$Start.xlsx"
$backup = Join-Path $demo 'melbet-excel-backup.xlsx'
$hadOriginal = Test-Path $xlsx
# Only create the backup when there is none: a previous hard-killed demo may
# already have written demo data into the repo file, and copying that over the
# known-good backup would make the overwrite permanent.
if ($hadOriginal -and -not (Test-Path $backup)) {
    Copy-Item $xlsx $backup -Force
}

$env:ALLOW_LIVE_RUN = 'true'
$env:HEADLESS = 'false'
$env:MELBET_HEADLESS = 'false'
$env:INSTANCE_COUNT = '1'
$env:START_INDEX = "$Start"
$env:END_INDEX = "$End"
$env:ACCOUNT_DELAY_SECONDS = "$DelaySec"
$env:SEEN_NUMBERS_FILE = (Join-Path $ws 'demo\seen-numbers-demo.json')
$env:SEEN_NUMBERS_LOCK = (Join-Path $ws 'demo\seen-numbers-demo.json.lock')
$env:FORCE_ALT_LEDGER = 'true'
$env:BROWSER_CACHE_DIR = '.browser-cache\demo-melbet'
$env:SERVICE_NAME = 'melbet'
$env:EVENT_ROLE = 'loop'
$env:INSTANCE_ID = '1'
$env:EVENTS_DIR = (Join-Path $ws 'events')
$env:TELEGRAM_CHANNEL_ID = 'off'
# Demo captures go to the 1xauto tree, never into the production screenshots
# folder that export-numbers.js reads.
$env:SCREENSHOTS_DIR = (Join-Path $ws 'screenshots\demo-melbet')
New-Item -ItemType Directory -Force -Path $env:SCREENSHOTS_DIR | Out-Null
Remove-Item Env:BATCH_ID -ErrorAction SilentlyContinue
Remove-Item Env:RESUME_FROM_STATE -ErrorAction SilentlyContinue

$sender = $null
try {
    # Same sender the farm uses, pointed at the demo ledger, so each dial is
    # posted to the admin chat as soon as its screenshot is written.
    $env:EVENT_ROLE = 'sender'
    $sender = Start-Process -FilePath 'node' `
        -ArgumentList 'scripts/realtime-send.mjs' `
        -WorkingDirectory $melbet `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput (Join-Path $ws 'logs\live-demo-melbet-sender.log') `
        -RedirectStandardError (Join-Path $ws 'logs\live-demo-melbet-sender.err.log')

    & npx playwright test --workers=1 --reporter=line
    $code = $LASTEXITCODE
} finally {
    # Give the sender one poll cycle (5 s) plus the 2 s file-stability check so
    # the last dial of the batch is not cut off when Playwright exits.
    try {
        if ($sender -and -not $sender.HasExited) {
            Start-Sleep -Seconds 8
        }
    } catch {
        # process handle already gone
    }
    if ($sender) {
        Stop-Process -Id $sender.Id -Force -ErrorAction SilentlyContinue
    }
    if ($hadOriginal -and (Test-Path $backup)) {
        Copy-Item $backup $xlsx -Force -ErrorAction SilentlyContinue
    }
}

exit $code
