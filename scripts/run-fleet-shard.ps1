# run-fleet-shard.ps1
# One 1xbet shard of the fleet demo. Called by run-fleet-demo.ps1, not by hand.
#
#   powershell -NoProfile -File scripts\run-fleet-shard.ps1 -Service demo-s1 -Indices 1,2,3
#
# It sets the demo environment for exactly one shard (its own state file,
# screenshots dir, browser cache, summary and Excel file) and runs the real
# one-pass pipeline. Nothing here touches production state.

param(
    [Parameter(Mandatory = $true)][string]$Service,
    [Parameter(Mandatory = $true)][string]$Indices,
    [int]$DelayMs = 20000
)

$ErrorActionPreference = 'Stop'
$ws = 'C:\Users\Dell\Desktop\workspace\1xauto'
Set-Location $ws

$env:SERVICE_NAME = $Service
$env:EVENT_ROLE = 'loop'
$env:INSTANCE_ID = '1'
$env:EVENTS_DIR = (Join-Path $ws 'events')
$env:SEEN_NUMBERS_FILE = (Join-Path $ws 'seen-numbers.json')
$env:SEEN_NUMBERS_LOCK = (Join-Path $ws 'seen-numbers.json.lock')
$env:START_INDEX = '1'
$env:END_INDEX = '276'
$env:DEMO_INDICES = $Indices
$env:ACCOUNT_DELAY_MS = "$DelayMs"
$env:SCREENSHOTS_DIR = "screenshots\$Service"
$env:STATE_FILE = "state-$Service.json"
$env:RUN_SUMMARY_FILE = "run-summary-$Service.json"
$env:EXCEL_FILE = "extracted_numbers-$Service.xlsx"
$env:BROWSER_CACHE_DIR = ".browser-cache\$Service"
$env:HEADED = 'true'
$env:HEADLESS = 'false'
$env:SKIP_NOTIFY = 'false'
Remove-Item Env:BATCH_ID -ErrorAction SilentlyContinue
Remove-Item Env:GATE_PROBE -ErrorAction SilentlyContinue
Remove-Item Env:RESUME_FROM_STATE -ErrorAction SilentlyContinue

node scripts/scheduled-run.mjs
exit $LASTEXITCODE
