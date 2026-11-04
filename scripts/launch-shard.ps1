# launch-shard.ps1
# The single launch definition for one scraper. Used by run-all-shards.ps1 and
# by the admin bot's /restart command, so the environment can never drift
# between a cold start and a restart.
#
#   powershell -NoProfile -File scripts\launch-shard.ps1 -Name shard-1
#
# It starts a hidden PowerShell that runs `npm run loop` in the right directory
# and writes the child PID to shards\<name>.pid.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('shard-1', 'shard-2', 'melbet', 'linebet')]
    [string]$Name,

    # Continue the first pass at the account the saved state reached instead of
    # restarting at the shard's range start.
    [switch]$Resume,

    # Show the browser window (boss demo). Playwright reads HEADED, not HEADLESS.
    [switch]$Headed,

    # Pause between accounts. Default is 5 s on every scraper; set it explicitly
    # when you want a different value. 0 is accepted and means "no delay".
    [int]$AccountDelayMs = 5000
)

$ErrorActionPreference = 'Stop'

$ws        = 'C:\Users\Dell\Desktop\workspace\1xauto'
$melbet    = 'C:\Users\Dell\Desktop\workspace\melbet-autologin'
$linebet   = 'C:\Users\Dell\Desktop\workspace\Linebet-autologin'
$ledger    = Join-Path $ws 'seen-numbers.json'
$lock      = Join-Path $ws 'seen-numbers.json.lock'
$eventsDir = Join-Path $ws 'events'
$logDir    = Join-Path $ws 'logs'
$pidDir    = Join-Path $ws 'shards'
$pwsh      = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

New-Item -ItemType Directory -Force -Path $logDir, $pidDir, $eventsDir | Out-Null

function Quote([string]$value) {
    return $value.Replace("'", "''")
}

switch ($Name) {
    'shard-1' {
        $workDir = $ws
        $start = '1'
        $end = '276'
        $shots = 'screenshots\shard-1'
        $state = 'state-shard-1.json'
        $summary = 'run-summary-shard-1.json'
        $excel = 'extracted_numbers-shard-1.xlsx'
        $status = 'loop-status-shard-1.json'
        # Known-good accounts for the deposit gate probe. They come from long
        # success streaks, so a failure means the wallet, not the account.
        $probes = '22,98,135'
    }
    'shard-2' {
        # Retired from start-all.bat. Kept for the manual/demo headed flows so
        # the second half of the 1xbet list can still be run on its own.
        $workDir = $ws
        $start = '150'
        $end = '276'
        $shots = 'screenshots\shard-2'
        $state = 'state-shard-2.json'
        $summary = 'run-summary-shard-2.json'
        $excel = 'extracted_numbers-shard-2.xlsx'
        $status = 'loop-status-shard-2.json'
        $probes = '245,247,252'
    }
    'melbet' {
        $workDir = $melbet
        $start = '1'
        $end = ''
        $shots = 'screenshots'
        $state = ''
        $summary = ''
        $excel = ''
        $status = 'loop-status.json'
        $probes = ''
    }
    'linebet' {
        $workDir = $linebet
        $start = '1'
        # No END_INDEX: tests/login.spec.js falls back to the whole accounts.csv.
        $end = ''
        $shots = 'screenshots'
        $state = ''
        $summary = ''
        $excel = ''
        $status = 'loop-status.json'
        $probes = ''
    }
}

# ---------------------------------------------------------------------------
# Guards: the two silent misconfigurations that cost real numbers
# ---------------------------------------------------------------------------

if ($env:BATCH_ID) {
    throw "BATCH_ID must not be set by the launcher (tests/login.spec.js treats a changed value as 'starting fresh at 1')."
}

$ledgerBase = Split-Path $ledger -Leaf
if ($ledgerBase -ne 'seen-numbers.json' -and $env:FORCE_ALT_LEDGER -ne 'true') {
    throw "Refusing to launch with ledger '$ledgerBase'. Use shared seen-numbers.json (or FORCE_ALT_LEDGER=true)."
}

$shotsBase = Split-Path $shots -Leaf
$expectedShots = if ($Name -eq 'melbet' -or $Name -eq 'linebet') { 'screenshots' } else { $Name }
if ($shotsBase -ne $expectedShots) {
    throw "SCREENSHOTS_DIR basename '$shotsBase' does not match '$expectedShots'. lib/extractor.js reads it at import time."
}

$shotsFull = Join-Path $workDir $shots
New-Item -ItemType Directory -Force -Path $shotsFull | Out-Null

# ---------------------------------------------------------------------------
# Command
# ---------------------------------------------------------------------------

$lines = @(
    "`$Host.UI.RawUI.WindowTitle = '$Name';",
    "Set-Location '$(Quote $workDir)';",
    # Clear caller-scoped runtime flags first. This process inherits the
    # caller's environment, so a demo that exported DEMO_INDICES (or HEADED,
    # GATE_PROBE, ACCOUNT_DELAY_MS) would silently reshape a production shard.
    "Remove-Item Env:DEMO_INDICES -ErrorAction SilentlyContinue;",
    "Remove-Item Env:GATE_PROBE -ErrorAction SilentlyContinue;",
    "Remove-Item Env:RESUME_FROM_STATE -ErrorAction SilentlyContinue;",
    "Remove-Item Env:HEADED -ErrorAction SilentlyContinue;",
    "Remove-Item Env:MELBET_HEADLESS -ErrorAction SilentlyContinue;",
    "Remove-Item Env:INSTANCE_COUNT -ErrorAction SilentlyContinue;",
    "Remove-Item Env:ACCOUNT_DELAY_MS -ErrorAction SilentlyContinue;",
    "Remove-Item Env:ACCOUNT_DELAY_SECONDS -ErrorAction SilentlyContinue;",
    "Remove-Item Env:BATCH_ID -ErrorAction SilentlyContinue;",
    "`$env:SERVICE_NAME='$Name';",
    "`$env:EVENT_ROLE='loop';",
    "`$env:INSTANCE_ID='1';",
    "`$env:EVENTS_DIR='$(Quote $eventsDir)';",
    "`$env:SEEN_NUMBERS_FILE='$(Quote $ledger)';",
    "`$env:SEEN_NUMBERS_LOCK='$(Quote $lock)';",
    "`$env:COOLDOWN_MINUTES='90';",
    "`$env:NOTIFY_INTERVAL_MINUTES='0';",
    "`$env:STATUS_FILE='$status';"
)

if ($Name -eq 'melbet') {
    # Melbet's own code defaults to 2 parallel instances. The farm runs ONE
    # browser for melbet, so make that explicit and independent of the default.
    $lines += "`$env:INSTANCE_COUNT='1';"
    # melbet reads the delay in seconds; the launcher uses milliseconds.
    $delaySeconds = [math]::Ceiling($AccountDelayMs / 1000)
    $lines += "`$env:ACCOUNT_DELAY_SECONDS='$delaySeconds';"
    # melbet's own loop reads MELBET_HEADLESS, not HEADED: its repo must stay
    # headless unless this launcher explicitly asks for otherwise.
    if ($Headed) {
        $lines += "`$env:MELBET_HEADLESS='false';"
    }
} elseif ($Name -eq 'linebet') {
    # linebet has no state file, no deposit gate and no parallel instances: its
    # loop always walks the whole accounts.csv (END_INDEX is left unset).
    $lines += @(
        "`$env:START_INDEX='$start';",
        "`$env:END_INDEX='$end';",
        "`$env:SCREENSHOTS_DIR='$shots';",
        # One disk cache per shard: Chromium cannot share a cache directory
        # between processes, so a shared one leaves a shard uncached.
        "`$env:BROWSER_CACHE_DIR='.browser-cache\$Name';"
    )
    if ($Headed) {
        $lines += "`$env:HEADED='true';"
    }
    # linebet reads seconds, not milliseconds.
    $delaySeconds = [math]::Ceiling($AccountDelayMs / 1000)
    $lines += "`$env:ACCOUNT_DELAY_SECONDS='$delaySeconds';"
} else {
    $lines += @(
        "`$env:START_INDEX='$start';",
        "`$env:END_INDEX='$end';",
        "`$env:STATE_FILE='$state';",
        "`$env:RUN_SUMMARY_FILE='$summary';",
        "`$env:EXCEL_FILE='$excel';",
        "`$env:SCREENSHOTS_DIR='$shots';",
        "`$env:GATE_PROBE_INDICES='$probes';",
        # One disk cache per shard: Chromium cannot share a cache directory
        # between processes, so a shared one leaves a shard uncached.
        "`$env:BROWSER_CACHE_DIR='.browser-cache\$Name';"
    )
    if ($Resume) {
        $lines += "`$env:RESUME_FROM_STATE='true';"
    }
    if ($Headed) {
        $lines += "`$env:HEADED='true';"
    }
    # 1xbet reads the delay in milliseconds.
    $lines += "`$env:ACCOUNT_DELAY_MS='$AccountDelayMs';"
}

$lines += 'npm run loop'
$command = $lines -join ' '

$out = Join-Path $logDir "$Name.log"
$err = Join-Path $logDir "$Name.err.log"

$proc = Start-Process -FilePath $pwsh `
    -ArgumentList '-NoProfile', '-Command', $command `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err `
    -WindowStyle Hidden `
    -PassThru

$pidFile = Join-Path $pidDir "$Name.pid"
Set-Content -Path $pidFile -Value $proc.Id -Encoding ASCII

Write-Host ("[{0}] started (PID {1}) -> {2}" -f $Name, $proc.Id, $out) -ForegroundColor Green
Write-Output $proc.Id
