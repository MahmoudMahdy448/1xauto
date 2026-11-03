# demo-service.ps1
# One headed external autologin service for the live demo. Started by
# scripts/live-demo.mjs, not by hand.
#
# The five external repos share the same platform family but not the same
# launcher: some honour SCREENSHOTS_DIR / STATE_FILE / EXCEL_FILE, two needed a
# small default-preserving patch. This wrapper gives every one of them the same
# demo contract:
#   * headed browser, 1 worker
#   * screenshots, state, summary and excel under the 1xauto demo tree
#   * the shared demo ledger, so repeats across services are skipped
#   * Telegram channel off; the 1xauto realtime sender posts each dial to the
#     admin chat and emits send.ok events for the panel's latency KPIs
#   * its own browser cache, so stopping the demo cannot touch production

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('betjam', 'fastpari', 'lilbet', 'linebet', 'paripulse')]
    [string]$Service,
    [int]$Start = 1,
    [int]$End = 3,
    [int]$DelayMs = 20000
)

$ErrorActionPreference = 'Stop'
$ws = 'C:\Users\Dell\Desktop\workspace\1xauto'
$demo = Join-Path $ws 'demo'
$logs = Join-Path $ws 'logs'
$events = Join-Path $ws 'events'
$shots = Join-Path $ws "screenshots\$Service"

$repos = @{
    betjam    = 'betjam-autologin'
    fastpari  = 'fastpari-autologin'
    lilbet    = 'lilbet-autologin'
    linebet   = 'Linebet-autologin'
    paripulse = 'paripulse-autologin'
}
$repo = Join-Path 'C:\Users\Dell\Desktop\workspace' $repos[$Service]

# Lilbet's autologin repo ships a single row in accounts.csv; the full list of
# registered lilbet accounts lives in the autoreg repo. Point the demo (and only
# the demo) at that file, read-only, so a full pass covers every account.
if ($Service -eq 'lilbet') {
    $env:ACCOUNTS_FILE = 'C:\Users\Dell\Desktop\workspace\lilbet-autoreg\accounts.csv'
}

New-Item -ItemType Directory -Force -Path $demo, $logs, $events, $shots | Out-Null
Set-Location $repo

# --- shared demo contract ---------------------------------------------------
$env:HEADLESS = 'false'
$env:HEADED = 'true'
$env:ALLOW_LIVE_RUN = 'true'
$env:START_INDEX = "$Start"
$env:END_INDEX = "$End"
$env:SCREENSHOTS_DIR = $shots
$env:STATE_FILE = (Join-Path $demo "state-$Service.json")
$env:SESSION_STATE_FILE = (Join-Path $demo "auth-state-$Service.json")
$env:RUN_SUMMARY_FILE = (Join-Path $demo "run-summary-$Service.json")
$env:EXCEL_FILE = (Join-Path $demo "extracted_numbers-$Service.xlsx")
$env:NUMBERS_JSON_FILE = (Join-Path $demo "extracted_numbers-$Service.json")
$env:EXTRACTED_LOG = (Join-Path $demo "extracted-$Service.jsonl")
$env:FAILED_LOG = (Join-Path $demo "failed-$Service.log")
$env:FAILURES_JSON = (Join-Path $demo "failures-$Service.jsonl")
$env:SEEN_NUMBERS_FILE = (Join-Path $demo 'seen-numbers-demo.json')
$env:SEEN_NUMBERS_LOCK = (Join-Path $demo 'seen-numbers-demo.json.lock')
$env:BROWSER_CACHE_DIR = ".browser-cache\demo-$Service"
$env:SERVICE_NAME = $Service
$env:EVENT_ROLE = 'loop'
$env:INSTANCE_ID = '1'
$env:EVENTS_DIR = $events
$env:TELEGRAM_CHANNEL_ID = 'off'
# lilbet notifies inline during the spec; the panel's sender does that here.
$env:SKIP_NOTIFY = 'true'

switch ($Service) {
    'betjam' { $env:ACCOUNT_DELAY_SECONDS = "$([math]::Round($DelayMs / 1000))" }
    'linebet' { $env:ACCOUNT_DELAY_SECONDS = "$([math]::Round($DelayMs / 1000))" }
    'paripulse' {
        $env:RANDOM_MIN_DELAY_MS = "$DelayMs"
        $env:RANDOM_MAX_DELAY_MS = "$DelayMs"
    }
    default { $env:ACCOUNT_DELAY_MS = "$DelayMs" }
}

Remove-Item Env:BATCH_ID -ErrorAction SilentlyContinue
Remove-Item Env:RESUME_FROM_STATE -ErrorAction SilentlyContinue

$sender = $null
$code = 1
try {
    # One realtime sender per service, watching only this service's demo
    # screenshots. It uses the shared demo ledger and emits send.ok events.
    $env:EVENT_ROLE = 'sender'
    $senderOut = Join-Path $logs "live-demo-$Service-sender.log"
    $senderErr = Join-Path $logs "live-demo-$Service-sender.err.log"
    $sender = Start-Process -FilePath 'node' `
        -ArgumentList (Join-Path $ws 'scripts\realtime-send.mjs') `
        -WorkingDirectory $ws `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput $senderOut `
        -RedirectStandardError $senderErr

    & npx.cmd playwright test --workers=1 --reporter=line
    $code = $LASTEXITCODE
} finally {
    # Give the sender one poll cycle (5 s) plus the 2 s file-stability check so
    # the last dial of the batch is not cut off when Playwright exits.
    try {
        if ($sender -and -not $sender.HasExited) {
            Start-Sleep -Seconds 10
        }
    } catch {
        # process handle already gone
    }
    if ($sender) {
        Stop-Process -Id $sender.Id -Force -ErrorAction SilentlyContinue
    }
}

exit $code
