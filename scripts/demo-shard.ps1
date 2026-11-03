# demo-shard.ps1
# One headed 1xbet shard for the live demo. Started by scripts/live-demo.mjs,
# not by hand.
#
# Differences from the production launcher:
#   * its own ledger (demo/seen-numbers-demo.json) so every captured number is
#     new for the demo and the realtime sender actually delivers it
#   * Telegram channel disabled (TELEGRAM_CHANNEL_ID=off) so demo dials land in
#     the admin chat only, never in the public channel
#   * its own state, screenshots dir and browser cache under the demo service
#     name, so production state is never touched

param(
    [Parameter(Mandatory = $true)][ValidateSet('demo-s1', 'demo-s2')][string]$Service,
    [int]$Start = 1,
    [int]$End = 276,
    [int]$DelayMs = 20000
)

$ErrorActionPreference = 'Stop'
$ws = 'C:\Users\Dell\Desktop\workspace\1xauto'
Set-Location $ws

$env:SERVICE_NAME = $Service
$env:EVENT_ROLE = 'loop'
$env:INSTANCE_ID = '1'
$env:EVENTS_DIR = (Join-Path $ws 'events')
$env:SEEN_NUMBERS_FILE = (Join-Path $ws 'demo\seen-numbers-demo.json')
$env:SEEN_NUMBERS_LOCK = (Join-Path $ws 'demo\seen-numbers-demo.json.lock')
$env:FORCE_ALT_LEDGER = 'true'
$env:START_INDEX = "$Start"
$env:END_INDEX = "$End"
Remove-Item Env:DEMO_INDICES -ErrorAction SilentlyContinue
$env:ACCOUNT_DELAY_MS = "$DelayMs"
$env:SCREENSHOTS_DIR = "screenshots\$Service"
$env:STATE_FILE = "state-$Service.json"
$env:RUN_SUMMARY_FILE = "run-summary-$Service.json"
$env:EXCEL_FILE = "extracted_numbers-$Service.xlsx"
$env:BROWSER_CACHE_DIR = ".browser-cache\$Service"
$env:HEADED = 'true'
$env:HEADLESS = 'false'
$env:SKIP_NOTIFY = 'true'
$env:TELEGRAM_CHANNEL_ID = 'off'
Remove-Item Env:BATCH_ID -ErrorAction SilentlyContinue
Remove-Item Env:GATE_PROBE -ErrorAction SilentlyContinue
Remove-Item Env:RESUME_FROM_STATE -ErrorAction SilentlyContinue

node scripts/scheduled-run.mjs
exit $LASTEXITCODE
