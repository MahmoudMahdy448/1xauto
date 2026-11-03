# run-fleet-demo.ps1
# The boss demo, fleet edition: pause the farm, run TWO 1xbet shards and ONE
# melbet shard at the same time in visible browsers, and show the fleet control
# room while the real pipeline works.
#
#   powershell -NoProfile -File scripts\run-fleet-demo.ps1
#   powershell -NoProfile -File scripts\run-fleet-demo.ps1 -IndicesS1 1,2 -IndicesS2 245,247 -MelbetEnd 1
#
# It uses the REAL ledger and the REAL Telegram channel on purpose. Both 1xbet
# shards attach the real sender, so a genuinely new number is posted live and a
# duplicate is shown as "already seen". Melbet runs extract-only: its ledger is
# far behind the shared one, so attaching its sender would re-post ~950 numbers.
#
# The farm is restored when the demo ends (shard-2 + ledger sync + monitor),
# unless -NoRestart is passed.

param(
    [string]$IndicesS1 = '1,2,3',
    [string]$IndicesS2 = '245,247,252',
    [int]$DelayMs = 20000,
    [int]$MelbetStart = 1,
    [int]$MelbetEnd = 2,
    [int]$MelbetDelaySec = 20,
    [int]$SoloSeconds = 110,
    [int]$Port = 8787,
    [switch]$NoOpen,
    [switch]$NoWait,
    [switch]$NoRestart,
    [switch]$SkipPause
)

$ErrorActionPreference = 'Stop'
$ws = 'C:\Users\Dell\Desktop\workspace\1xauto'
$melbet = 'C:\Users\Dell\Desktop\workspace\melbet-autologin'
$pwsh = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Set-Location $ws

function Write-Step([string]$text) {
    Write-Host ''
    Write-Host "== $text" -ForegroundColor Cyan
}

function Count-Indices([string]$raw) {
    return ($raw -split ',' | Where-Object { $_.Trim() }).Count
}

function Write-DemoStatus([string]$service, [string]$indices, [string]$state) {
    @{
        state           = $state
        startIndex      = 1
        endIndex        = 276
        cooldownMinutes = 90
        group           = 'A'
        run             = 1
        demoTotal       = (Count-Indices $indices)
        demoIndices     = $indices
        updatedAt       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        nextRunAt       = $null
    } | ConvertTo-Json | Set-Content -Path "loop-status-$service.json" -Encoding UTF8
}

function Stop-DemoWatcher {
    $file = Join-Path $ws 'shards\demo-watch.pid'
    if (-not (Test-Path $file)) { return }
    $old = Get-Content $file -ErrorAction SilentlyContinue
    if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
        # Kill the tree: a stale watcher would keep the port and the demo screen
        # would silently open on the next port while this script prints the old.
        & taskkill.exe /PID $old /T /F 2>$null | Out-Null
        Start-Sleep -Milliseconds 700
        Write-Host "[demo] stopped the previous dashboard (PID $old)." -ForegroundColor DarkYellow
    }
    Remove-Item $file -Force -ErrorAction SilentlyContinue
}

function Stop-DemoChildren {
    # Kill only this demo's trees. Production is launched as shard-2/run-loop,
    # so it never matches these command lines.
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -match 'run-fleet-shard' -or $_.CommandLine -match 'melbet-autologin') }
    foreach ($proc in $procs) {
        & taskkill.exe /PID $proc.ProcessId /T /F 2>$null | Out-Null
    }
}

function Clear-DemoEnvironment {
    foreach ($v in 'DEMO_INDICES','HEADED','GATE_PROBE','RESUME_FROM_STATE','START_INDEX','END_INDEX',
                   'SERVICE_NAME','SCREENSHOTS_DIR','STATE_FILE','RUN_SUMMARY_FILE','EXCEL_FILE',
                   'BROWSER_CACHE_DIR','ACCOUNT_DELAY_MS','EVENT_ROLE','SKIP_NOTIFY','INSTANCE_ID',
                   'FLEET_SERVICES','FLEET_START_AT','MELBET_LOG','MELBET_ROOT','MELBET_START','MELBET_END') {
        Remove-Item "Env:$v" -ErrorAction SilentlyContinue
    }
}

function Restore-Farm {
    if ($NoRestart) {
        Write-Host '[demo] -NoRestart: leaving everything stopped.' -ForegroundColor Yellow
        return
    }
    Write-Step 'restoring shard-2 (resume, 10 s pacing) plus ledger sync and monitor'
    Clear-DemoEnvironment
    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch-shard.ps1 -Name shard-2 -Resume -AccountDelayMs 10000

    $eventsDir = Join-Path $ws 'events'
    $ledger = Join-Path $ws 'seen-numbers.json'
    $lock = Join-Path $ws 'seen-numbers.json.lock'

    $syncCmd = "Set-Location '$ws'; `$env:SERVICE_NAME='sync'; `$env:EVENT_ROLE='sync'; `$env:INSTANCE_ID='1'; `$env:EVENTS_DIR='$eventsDir'; `$env:SEEN_NUMBERS_FILE='$ledger'; `$env:SEEN_NUMBERS_LOCK='$lock'; node scripts/telegram-sync-loop.mjs"
    $sync = Start-Process -FilePath $pwsh -ArgumentList '-NoProfile','-Command',$syncCmd -RedirectStandardOutput (Join-Path $ws 'logs\telegram-sync.log') -RedirectStandardError (Join-Path $ws 'logs\telegram-sync.err.log') -WindowStyle Hidden -PassThru
    Set-Content -Path (Join-Path $ws 'shards\telegram-sync.pid') -Value $sync.Id -Encoding ASCII

    $sup = Start-Process -FilePath $pwsh -ArgumentList '-NoProfile','-Command',"Set-Location '$ws'; node scripts/monitor-supervisor.mjs" -RedirectStandardOutput (Join-Path $ws 'logs\monitor-supervisor.log') -RedirectStandardError (Join-Path $ws 'logs\monitor-supervisor.err.log') -WindowStyle Hidden -PassThru
    Set-Content -Path (Join-Path $ws 'shards\monitor-supervisor.pid') -Value $sup.Id -Encoding ASCII

    if (-not (Test-Path (Join-Path $ws 'shards\demo-watch.pid'))) {
        $live = Start-Process node -ArgumentList 'scripts/demo-watch.mjs','--service','shard-2','--port',"$Port" `
            -RedirectStandardOutput (Join-Path $ws 'logs\demo-watch.log') `
            -RedirectStandardError (Join-Path $ws 'logs\demo-watch.err.log') `
            -WindowStyle Hidden -PassThru
        Set-Content -Path (Join-Path $ws 'shards\demo-watch.pid') -Value $live.Id -Encoding ASCII
        Write-Host "[demo] live control room restored: http://127.0.0.1:$Port/" -ForegroundColor Green
    }

    Write-Host '[demo] farm restored: shard-2 + sync + monitor.' -ForegroundColor Green
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

if (Test-Path 'deposit-gate.json') {
    $gate = Get-Content 'deposit-gate.json' -Raw | ConvertFrom-Json
    if ($gate.disabled) {
        Write-Host '[demo] refused: the 1xbet deposit gate says vodafone is disabled.' -ForegroundColor Red
        Write-Host '[demo] the demo would only produce payment-disabled failures; wait for the gate to reopen.' -ForegroundColor Yellow
        exit 1
    }
}

if (-not (Test-Path 'accounts.csv')) {
    Write-Host '[demo] accounts.csv is missing.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $melbet 'tests\login.spec.js'))) {
    Write-Host "[demo] melbet workspace not found at $melbet" -ForegroundColor Red
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
Write-Host ("[demo] 1xbet shard 1: {0} · shard 2: {1} · pacing {2} ms" -f $IndicesS1, $IndicesS2, $DelayMs)
Write-Host ("[demo] melbet: accounts {0}-{1} · {2} s pacing · extract-only, no sender" -f $MelbetStart, $MelbetEnd, $MelbetDelaySec)
Write-Host ("[demo] port: {0}" -f $Port)

# ---------------------------------------------------------------------------
# pause, reset, dashboard
# ---------------------------------------------------------------------------

if (-not $SkipPause) {
    Write-Step 'pausing the real farm'
    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-pipeline.ps1 -All
    Start-Sleep -Seconds 2
}

Write-Step 'resetting fleet demo output'
foreach ($service in 'demo-s1','demo-s2') {
    Remove-Item "state-$service.json", "run-summary-$service.json", "loop-status-$service.json", `
        "extracted_numbers-$service.xlsx" -Force -ErrorAction SilentlyContinue
    Remove-Item "screenshots\$service\*.png" -Force -ErrorAction SilentlyContinue
    Remove-Item "events\$service-*.jsonl" -Force -ErrorAction SilentlyContinue
    Remove-Item "logs\$service.log", "logs\$service.err.log" -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force "screenshots\$service" | Out-Null
}
Remove-Item 'logs\melbet-demo.log', 'logs\melbet-demo.err.log' -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force logs | Out-Null

# Melbet's spec overwrites extracted_numbers-1.xlsx. Put the real one back when
# the demo ends, even if a run fails.
$melbetXlsx = Join-Path $melbet "extracted_numbers-$MelbetStart.xlsx"
$melbetBackup = Join-Path $env:TEMP "melbet-extracted_numbers-$MelbetStart.fleet-backup.xlsx"
$melbetHadOriginal = Test-Path $melbetXlsx
if ($melbetHadOriginal) {
    Copy-Item $melbetXlsx $melbetBackup -Force
    Write-Host "[demo] backed up melbet export to $melbetBackup" -ForegroundColor DarkYellow
}

Stop-DemoWatcher

$fleetStartAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$env:FLEET_SERVICES = 'demo-s1,demo-s2,melbet'
$env:FLEET_START_AT = $fleetStartAt
$env:MELBET_LOG = (Join-Path $ws 'logs\melbet-demo.log')

$watchArgs = @('scripts/demo-watch.mjs', '--service', 'all', '--port', "$Port")
if (-not $NoOpen) { $watchArgs += '--open' }
$watch = Start-Process node -ArgumentList $watchArgs `
    -RedirectStandardOutput 'logs\fleet-watch.log' -RedirectStandardError 'logs\fleet-watch.err.log' `
    -WindowStyle Hidden -PassThru
Set-Content -Path 'shards\demo-watch.pid' -Value $watch.Id -Encoding ASCII

Write-DemoStatus 'demo-s1' $IndicesS1 'running'
# demo-s2 stays unmarked until phase 2; otherwise the dashboard would report
# three "running" shards during the solo phase and the baseline would be wrong.
Write-DemoStatus 'demo-s2' $IndicesS2 'finished'

Write-Host "[demo] fleet dashboard: http://127.0.0.1:$Port/  (opening the default browser)" -ForegroundColor Green
Start-Sleep -Seconds 3

# ---------------------------------------------------------------------------
# run all three at once
# ---------------------------------------------------------------------------

Write-Step 'phase 1 — one shard alone (the 1-shard baseline)'
$soloTarget = [Math]::Min(2, (Count-Indices $IndicesS1))
$shard1Proc = Start-Process -FilePath $pwsh -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','scripts\run-fleet-shard.ps1','-Service','demo-s1','-Indices',$IndicesS1,'-DelayMs',"$DelayMs" `
    -RedirectStandardOutput 'logs\demo-s1.log' -RedirectStandardError 'logs\demo-s1.err.log' `
    -WindowStyle Hidden -PassThru
Write-Host "[demo] shard-1 alone until $soloTarget account(s) finish (max $SoloSeconds s). The dashboard records this rate as the 1-shard baseline." -ForegroundColor DarkGray

$soloDeadline = (Get-Date).AddSeconds([Math]::Max(30, $SoloSeconds))
$soloReady = $false
while ((Get-Date) -lt $soloDeadline) {
    try {
        $snap = Invoke-RestMethod "http://127.0.0.1:$Port/api/state" -TimeoutSec 3
        $one = $snap.services | Where-Object { $_.id -eq 'demo-s1' }
        $done = if ($one) { [int]$one.batch.ok } else { 0 }
        if ($snap.comparison.soloMeasured -and $done -ge $soloTarget) {
            $soloReady = $true
            break
        }
    } catch {
        // watcher not answering yet; keep waiting
    }
    Start-Sleep -Seconds 2
}
if (-not $soloReady) {
    Write-Host '[demo] solo baseline was not fully measured before the timeout; continuing anyway.' -ForegroundColor Yellow
}

Write-Step 'phase 2 — adding melbet and 1xbet shard 2 (three shards now)'
$melbetCmd = "Set-Location '$melbet'; `$env:ALLOW_LIVE_RUN='true'; `$env:HEADLESS='false'; " +
    "`$env:START_INDEX='$MelbetStart'; `$env:END_INDEX='$MelbetEnd'; " +
    "`$env:ACCOUNT_DELAY_SECONDS='$MelbetDelaySec'; npx playwright test --workers=1 --reporter=line"
$melbetProc = Start-Process -FilePath $pwsh -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',$melbetCmd `
    -RedirectStandardOutput 'logs\melbet-demo.log' -RedirectStandardError 'logs\melbet-demo.err.log' `
    -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 10

Write-DemoStatus 'demo-s2' $IndicesS2 'running'
$shard2Proc = Start-Process -FilePath $pwsh -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','scripts\run-fleet-shard.ps1','-Service','demo-s2','-Indices',$IndicesS2,'-DelayMs',"$DelayMs" `
    -RedirectStandardOutput 'logs\demo-s2.log' -RedirectStandardError 'logs\demo-s2.err.log' `
    -WindowStyle Hidden -PassThru

Write-Host "[demo] running: melbet PID $($melbetProc.Id) · shard-1 PID $($shard1Proc.Id) · shard-2 PID $($shard2Proc.Id)" -ForegroundColor DarkGray

$timedOut = $false
$demoPids = @($melbetProc.Id, $shard1Proc.Id, $shard2Proc.Id)
$deadline = (Get-Date).AddMinutes(15)
$alive = @($demoPids)
while ($true) {
    # Wait-Process aborts if any PID has already exited, and a fast shard can
    # finish before the others. Poll the live set instead.
    $alive = @($demoPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($alive.Count -eq 0) { break }
    if ((Get-Date) -ge $deadline) {
        $timedOut = $true
        Write-Host '[demo] one or more shards did not finish within 15 minutes; stopping them.' -ForegroundColor Yellow
        Stop-DemoChildren
        Start-Sleep -Seconds 1
        break
    }
    Start-Sleep -Seconds 2
}
# A Playwright child can outlive its PowerShell parent; make sure no demo tree
# is still writing screenshots or the melbet export when we restore.
Stop-DemoChildren

Write-DemoStatus 'demo-s1' $IndicesS1 'finished'
Write-DemoStatus 'demo-s2' $IndicesS2 'finished'

# Restore melbet's export immediately: the boss screen does not need it, and a
# finished demo must not leave a rewritten melbet ledger export behind.
if ($melbetHadOriginal) {
    Copy-Item $melbetBackup $melbetXlsx -Force
    Write-Host '[demo] melbet export restored.' -ForegroundColor Green
} elseif (Test-Path $melbetXlsx) {
    Remove-Item $melbetXlsx -Force -ErrorAction SilentlyContinue
}
# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------

Write-Step 'demo finished'
foreach ($service in 'demo-s1','demo-s2') {
    if (Test-Path "run-summary-$service.json") {
        $summary = Get-Content "run-summary-$service.json" -Raw | ConvertFrom-Json
        Write-Host ("[demo] {0}: ok={1} failed={2} · unique numbers={3}" -f $service, $summary.succeeded, $summary.failed, $summary.uniqueNumbers)
    } else {
        Write-Host "[demo] $service wrote no run summary." -ForegroundColor Yellow
    }
}
$melbetSaved = Select-String -Path 'logs\melbet-demo.log' -Pattern 'Saved (\d+) unique number' -ErrorAction SilentlyContinue |
    Select-Object -Last 1
if ($melbetSaved) {
    Write-Host ("[demo] melbet: {0}" -f $melbetSaved.Line.Trim())
} else {
    Write-Host '[demo] melbet wrote no export line; check logs\melbet-demo.log.' -ForegroundColor Yellow
}
if ($timedOut) {
    Write-Host '[demo] note: a shard timed out; see the logs.' -ForegroundColor Yellow
}

Write-Host ''
if ($NoWait) {
    Write-Host '[demo] -NoWait: closing the dashboard and restoring without a keypress.' -ForegroundColor Yellow
} else {
    Write-Host "[demo] the fleet dashboard is still live at http://127.0.0.1:$Port/ — leave it on screen." -ForegroundColor Green
    Write-Host '[demo] Press Enter to close the dashboard and restore the farm.' -ForegroundColor Yellow
    Read-Host | Out-Null
}

try {
    if ($watch -and (Get-Process -Id $watch.Id -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $watch.Id -Force
    }
} catch {
    // already gone
}
Remove-Item 'shards\demo-watch.pid' -Force -ErrorAction SilentlyContinue

# Move this demo's melbet screenshots out of the live folder so a later melbet
# sender does not re-post them as new captures. Done after the dashboard closes,
# so the boss can open the thumbnails while the demo is on screen.
$melbetShots = Join-Path $melbet 'screenshots'
$kept = Join-Path $melbet ('screenshots\fleet-demo-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$startTime = [datetimeoffset]::Parse($fleetStartAt)
$newShots = Get-ChildItem $melbetShots -File -Filter *.png -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $startTime.LocalDateTime }
if ($newShots) {
    New-Item -ItemType Directory -Force $kept | Out-Null
    $newShots | Move-Item -Destination $kept -Force
    Write-Host "[demo] melbet screenshots kept in $kept" -ForegroundColor DarkYellow
}

if ($wasRunning) {
    Restore-Farm
} else {
    Write-Host '[demo] the farm was not running before the demo; leaving it stopped.' -ForegroundColor Yellow
}

exit 0
