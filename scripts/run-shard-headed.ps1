# run-shard-headed.ps1
# Run ONE shard by itself with a visible browser, and nothing else.
#
#   powershell -NoProfile -File scripts\run-shard-headed.ps1 -Name shard-2 -Resume
#
# This starts the real shard through scripts\launch-shard.ps1 - the same
# definition the farm and the admin bot use - so it keeps its own state, state
# file, screenshots and log. It does NOT start the ledger sync or the monitor:
# use start-all.bat for the whole farm.
#
# It refuses to start while the farm is running, because a second copy of the
# same shard would scrape the same accounts into the same ledger.
#
# Press Q to stop this shard. Ctrl+C and closing the window do the same.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('shard-1', 'shard-2', 'melbet')]
    [string]$Name,

    # Continue at the account the saved state reached instead of restarting the
    # pass at the shard's range start.
    [switch]$Resume,

    # Pause between accounts. 0 keeps the built-in default.
    [int]$AccountDelayMs = 0
)

$ErrorActionPreference = 'Stop'

$ws      = 'C:\Users\Dell\Desktop\workspace\1xauto'
$pidDir  = Join-Path $ws 'shards'
$logDir  = Join-Path $ws 'logs'
$launch  = Join-Path $ws 'scripts\launch-shard.ps1'
Set-Location $ws

function Get-Pid([string]$name) {
    $file = Join-Path $pidDir "$name.pid"
    if (-not (Test-Path $file)) { return 0 }
    $raw = (Get-Content $file -Raw).Trim()
    $value = 0
    if ([int]::TryParse($raw, [ref]$value)) { return $value }
    return 0
}

function Test-Alive([int]$processId) {
    if ($processId -le 0) { return $false }
    return [bool](Get-Process -Id $processId -ErrorAction SilentlyContinue)
}

function Read-Json([string]$file) {
    if (-not (Test-Path $file)) { return $null }
    try { return Get-Content $file -Raw | ConvertFrom-Json } catch { return $null }
}

function Stop-OwnShard {
    $processId = Get-Pid $Name
    if (Test-Alive $processId) {
        & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
        Start-Sleep -Milliseconds 700
    }
    Remove-Item (Join-Path $pidDir "$Name.pid") -Force -ErrorAction SilentlyContinue
}

switch ($Name) {
    'shard-1' { $statusFile = 'loop-status-shard-1.json'; $stateFile = 'state-shard-1.json' }
    'shard-2' { $statusFile = 'loop-status-shard-2.json'; $stateFile = 'state-shard-2.json' }
    'melbet'  { $statusFile = 'loop-status.json';        $stateFile = $null }
}

function Show-Status {
    $bits = @()
    $st = Read-Json (Join-Path $ws $statusFile)
    if ($st -and $st.state) { $bits += $st.state }
    if ($st -and $st.run) { $bits += "run $($st.run)" }
    if ($st -and $st.nextRunAt) {
        $mins = [Math]::Max(0, [Math]::Round(([datetimeoffset]::Parse($st.nextRunAt) - [datetimeoffset]::Now).TotalMinutes))
        $bits += "next in $mins min"
    }
    if ($stateFile) {
        $snap = Read-Json (Join-Path $ws $stateFile)
        if ($snap -and $snap.lastProcessedIndex) {
            $bits += "account $($snap.lastProcessedIndex)/$($snap.totalAccounts)"
        }
    }
    Write-Host ("[{0}] {1} · {2}" -f (Get-Date -Format 'HH:mm:ss'), $Name, ($bits -join ' · ')) -ForegroundColor DarkGray
    $tail = Get-Content (Join-Path $logDir "$Name.log") -Tail 1 -ErrorAction SilentlyContinue
    if ($tail) { Write-Host ("           " + $tail.Trim()) -ForegroundColor DarkGray }
}

# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

$pipelinePid = Get-Pid 'pipeline'
if (Test-Alive $pipelinePid) {
    Write-Host "[shard] the farm is already running (pipeline PID $pipelinePid)." -ForegroundColor Yellow
    Write-Host '[shard] stop it first:  stop-all.bat' -ForegroundColor Yellow
    exit 1
}

$ownPid = Get-Pid $Name
if (Test-Alive $ownPid) {
    Write-Host "[shard] $Name is already running (PID $ownPid)." -ForegroundColor Yellow
    Write-Host '[shard] stop it first:  stop-all.bat' -ForegroundColor Yellow
    exit 1
}

$others = @('shard-1', 'shard-2', 'melbet') |
    Where-Object { $_ -ne $Name -and (Test-Alive (Get-Pid $_)) }
if ($others.Count -gt 0) {
    Write-Host ("[shard] note: {0} is also running. You are not alone, and ledger sync is not running." -f ($others -join ', ')) -ForegroundColor DarkYellow
}

$freeMb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB)
if ($freeMb -lt 1500) {
    Write-Host ("[shard] warning: only {0} MB RAM free. A headed browser may be killed." -f $freeMb) -ForegroundColor DarkYellow
    Write-Host '[shard] close other browsers, or stop the farm first.' -ForegroundColor DarkYellow
}

Write-Host ''
Write-Host ("  {0} — headed, alone" -f $Name) -ForegroundColor Cyan
Write-Host ("  state: {0}" -f $(if ($Resume) { 'resume where it stopped' } else { 'fresh pass at range start' }))
Write-Host ("  log:   logs\{0}.log" -f $Name)
Write-Host ''

# ---------------------------------------------------------------------------
# Start, then watch
# ---------------------------------------------------------------------------

$launchArgs = @{ Name = $Name; Headed = $true }
if ($Resume) { $launchArgs.Resume = $true }
if ($AccountDelayMs -gt 0) { $launchArgs.AccountDelayMs = $AccountDelayMs }

try {
    & $launch @launchArgs
} catch {
    Write-Host ("[shard] start failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  press Q to stop this shard (Ctrl+C works too)' -ForegroundColor Yellow
Write-Host ''

$canReadKeys = $true
try { [void][Console]::KeyAvailable } catch { $canReadKeys = $false }

$lastStatus = Get-Date
try {
    while ($true) {
        if ($canReadKeys -and [Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)
            if ($key.Key -eq 'Q') {
                Write-Host ''
                Write-Host '[shard] stopping...' -ForegroundColor Yellow
                break
            }
        }

        if (-not (Test-Alive (Get-Pid $Name))) {
            Write-Host ''
            Write-Host "[shard] $Name exited. See logs\$Name.log and logs\$Name.err.log." -ForegroundColor Yellow
            break
        }

        if (((Get-Date) - $lastStatus).TotalSeconds -ge 15) {
            Show-Status
            $lastStatus = Get-Date
        }

        Start-Sleep -Milliseconds 400
    }
} finally {
    Stop-OwnShard
}

exit 0
