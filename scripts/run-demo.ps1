# run-demo.ps1
# The boss demo: pause the farm, run three known-good accounts in a visible
# browser, and show the control room while the real pipeline works.
#
#   powershell -NoProfile -File scripts\run-demo.ps1
#   powershell -NoProfile -File scripts\run-demo.ps1 -Indices 245,247,252 -DelayMs 15000
#
# It uses the REAL ledger and the REAL Telegram channel on purpose: a demo with
# a test channel would mark numbers delivered in the ledger and the real channel
# would never receive them. Duplicates are shown as "already seen" — that is the
# dedup rail doing its job, not a failure.
#
# The farm is restored when the demo ends (shard-2 at 10 s pacing), unless
# -NoRestart is passed.

param(
    [string]$Indices = '245,247,252',
    [int]$DelayMs = 15000,
    [int]$Port = 8787,
    [switch]$NoRestart,
    [switch]$SkipPause
)

$ErrorActionPreference = 'Stop'
$ws = 'C:\Users\Dell\Desktop\workspace\1xauto'
Set-Location $ws

function Write-Step([string]$text) {
    Write-Host ''
    Write-Host "== $text" -ForegroundColor Cyan
}

function Restore-Farm {
    if ($NoRestart) {
        Write-Host '[demo] -NoRestart: leaving everything stopped.' -ForegroundColor Yellow
        return
    }
    Write-Step 'restoring shard-2 (resume, 10 s pacing) plus monitor'
    # The launcher clears these too; this is the second layer, so the demo's
    # environment can never reach the production shard.
    foreach ($v in 'DEMO_INDICES','HEADED','GATE_PROBE','RESUME_FROM_STATE','START_INDEX','END_INDEX',
                   'SERVICE_NAME','SCREENSHOTS_DIR','STATE_FILE','RUN_SUMMARY_FILE','EXCEL_FILE',
                   'BROWSER_CACHE_DIR','ACCOUNT_DELAY_MS','EVENT_ROLE','SKIP_NOTIFY') {
        Remove-Item "Env:$v" -ErrorAction SilentlyContinue
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch-shard.ps1 -Name shard-2 -Resume -AccountDelayMs 10000

    $pwsh = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

    $sup = Start-Process -FilePath $pwsh -ArgumentList '-NoProfile','-Command',"Set-Location '$ws'; node scripts/monitor-supervisor.mjs" -RedirectStandardOutput (Join-Path $ws 'logs\monitor-supervisor.log') -RedirectStandardError (Join-Path $ws 'logs\monitor-supervisor.err.log') -WindowStyle Hidden -PassThru
    Set-Content -Path (Join-Path $ws 'shards\monitor-supervisor.pid') -Value $sup.Id -Encoding ASCII

    # Bring the live control room back for shard-2, on the same port the demo
    # used, so the screen keeps showing real work after the boss is done.
    if (-not (Test-Path (Join-Path $ws 'shards\demo-watch.pid'))) {
        $live = Start-Process node -ArgumentList 'scripts/demo-watch.mjs','--service','shard-2','--port',"$Port" `
            -RedirectStandardOutput (Join-Path $ws 'logs\demo-watch.log') `
            -RedirectStandardError (Join-Path $ws 'logs\demo-watch.err.log') `
            -WindowStyle Hidden -PassThru
        Set-Content -Path (Join-Path $ws 'shards\demo-watch.pid') -Value $live.Id -Encoding ASCII
        Write-Host "[demo] live control room restored: http://127.0.0.1:$Port/" -ForegroundColor Green
    }

    Write-Host '[demo] farm restored: shard-2 + monitor.' -ForegroundColor Green
}

function Stop-DemoWatcher {
    $file = Join-Path $ws 'shards\demo-watch.pid'
    if (-not (Test-Path $file)) { return }
    $old = Get-Content $file -ErrorAction SilentlyContinue
    if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
        # Kill the tree: a stale watcher would keep port 8787, and the demo
        # screen would silently open on 8788 while this script prints 8787.
        & taskkill.exe /PID $old /T /F 2>$null | Out-Null
        Start-Sleep -Milliseconds 700
        Write-Host "[demo] stopped the previous dashboard (PID $old)." -ForegroundColor DarkYellow
    }
    Remove-Item $file -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

Write-Step 'preflight'
"now $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Cairo"

if (Test-Path 'site-block.json') {
    $block = Get-Content 'site-block.json' -Raw | ConvertFrom-Json
    if ($block.blocked -and $block.blockedUntil) {
        $until = [datetimeoffset]::Parse($block.blockedUntil)
        if ($until -gt [datetimeoffset]::Now) {
            $minutes = [Math]::Ceiling(($until - [datetimeoffset]::Now).TotalMinutes)
            Write-Host "[demo] refused: 1xbet is blocking this IP for another $minutes min (until $($block.blockedUntil))." -ForegroundColor Red
            Write-Host '[demo] change the IP or run: node scripts/block-clear.mjs --yes' -ForegroundColor Yellow
            exit 1
        }
    }
}

if (-not (Test-Path 'accounts.csv')) {
    Write-Host '[demo] accounts.csv is missing.' -ForegroundColor Red
    exit 1
}

$wasRunning = $false
if (Test-Path 'shards\shard-2.pid') {
    $oldPid = Get-Content 'shards\shard-2.pid' -ErrorAction SilentlyContinue
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        $wasRunning = $true
    }
}
Write-Host ("[demo] farm running before demo: {0}" -f $(if ($wasRunning) { 'yes' } else { 'no' }))
Write-Host ("[demo] accounts: {0} · delay: {1} ms · port: {2}" -f $Indices, $DelayMs, $Port)

# ---------------------------------------------------------------------------
# pause, reset, dashboard
# ---------------------------------------------------------------------------

if (-not $SkipPause) {
    Write-Step 'pausing the real farm'
    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-pipeline.ps1 -All
    Start-Sleep -Seconds 2
}

Write-Step 'resetting demo output'
Remove-Item state-demo.json, run-summary-demo.json, loop-status-demo.json -Force -ErrorAction SilentlyContinue
Remove-Item screenshots\demo\*.png -Force -ErrorAction SilentlyContinue
# A second demo must not inherit the first one's numbers, sender counts or log:
# demo-watch reads every demo event file, and the sender counts are not
# batch-filtered.
Remove-Item events\demo-*.jsonl -Force -ErrorAction SilentlyContinue
Remove-Item logs\demo.log -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force screenshots\demo, logs | Out-Null

# The watcher inherits the environment at start time, so set this before it
# launches, not only for the runner below.
$env:DEMO_INDICES = $Indices

Stop-DemoWatcher
$watch = Start-Process node -ArgumentList 'scripts/demo-watch.mjs','--service','demo','--port',"$Port",'--open' `
    -RedirectStandardOutput 'logs\demo-watch.log' -RedirectStandardError 'logs\demo-watch.err.log' `
    -WindowStyle Hidden -PassThru
Set-Content -Path 'shards\demo-watch.pid' -Value $watch.Id -Encoding ASCII

@{
    state       = 'running'
    startIndex  = 1
    endIndex    = 276
    cooldownMinutes = 90
    group       = 'A'
    run         = 1
    updatedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    nextRunAt   = $null
} | ConvertTo-Json | Set-Content -Path loop-status-demo.json -Encoding UTF8

Write-Host "[demo] dashboard: http://127.0.0.1:$Port/  (opening the default browser)" -ForegroundColor Green

# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------

Write-Step "running $Indices in a visible browser"
$env:SERVICE_NAME = 'demo'
$env:EVENT_ROLE = 'loop'
$env:INSTANCE_ID = '1'
$env:EVENTS_DIR = (Join-Path $ws 'events')
$env:SEEN_NUMBERS_FILE = (Join-Path $ws 'seen-numbers.json')
$env:SEEN_NUMBERS_LOCK = (Join-Path $ws 'seen-numbers.json.lock')
$env:START_INDEX = '1'
$env:END_INDEX = '276'
$env:DEMO_INDICES = $Indices
$env:ACCOUNT_DELAY_MS = "$DelayMs"
$env:SCREENSHOTS_DIR = 'screenshots\demo'
$env:STATE_FILE = 'state-demo.json'
$env:RUN_SUMMARY_FILE = 'run-summary-demo.json'
$env:EXCEL_FILE = 'extracted_numbers-demo.xlsx'
$env:BROWSER_CACHE_DIR = '.browser-cache\demo'
$env:HEADED = 'true'
$env:HEADLESS = 'false'
$env:SKIP_NOTIFY = 'false'
Remove-Item Env:BATCH_ID -ErrorAction SilentlyContinue

$exitCode = 1
try {
    node scripts/scheduled-run.mjs 2>&1 | Tee-Object -FilePath logs\demo.log
    $exitCode = $LASTEXITCODE
} catch {
    Write-Host "[demo] runner failed: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    @{
        state       = 'finished'
        startIndex  = 1
        endIndex    = 276
        cooldownMinutes = 90
        group       = 'A'
        run         = 1
        updatedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        nextRunAt   = $null
    } | ConvertTo-Json | Set-Content -Path loop-status-demo.json -Encoding UTF8
}

Write-Step 'demo finished'
if (Test-Path 'run-summary-demo.json') {
    $summary = Get-Content 'run-summary-demo.json' -Raw | ConvertFrom-Json
    Write-Host ("[demo] accounts ok={0} failed={1} · unique numbers={2}" -f $summary.succeeded, $summary.failed, $summary.uniqueNumbers)
} else {
    Write-Host '[demo] no run summary was written.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host "[demo] the dashboard is still live at http://127.0.0.1:$Port/ — leave it on screen." -ForegroundColor Green
Write-Host '[demo] Press Enter to close the dashboard and restore the farm.' -ForegroundColor Yellow
Read-Host | Out-Null

try {
    if ($watch -and (Get-Process -Id $watch.Id -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $watch.Id -Force
    }
} catch {
    // already gone
}
Remove-Item 'shards\demo-watch.pid' -Force -ErrorAction SilentlyContinue

if ($wasRunning) {
    Restore-Farm
} else {
    Write-Host '[demo] the farm was not running before the demo; leaving it stopped.' -ForegroundColor Yellow
}

exit $exitCode
