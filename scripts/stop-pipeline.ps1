# stop-pipeline.ps1
# Stops everything start-all.bat can start.
#
# The scrapers are terminated (a batch cannot be paused safely midway), but the
# monitor is asked to stop instead of being killed: a flag file makes the
# supervisor send one Telegram notice, close the agent and the bot itself, and
# release its lock. SIGTERM cannot do that on Windows - process.kill there is a
# hard terminate - so the flag is the graceful path.
#
# Usage:
#   powershell -NoProfile -File scripts\stop-pipeline.ps1          # all services
#   powershell -NoProfile -File scripts\stop-pipeline.ps1 -All     # ... and the wrapper

param(
    # Also stop the start-all.bat wrapper (used by stop-all.bat).
    [switch]$All,

    # How long to wait for the supervisor to close itself.
    [int]$GraceSeconds = 10
)

$ErrorActionPreference = 'SilentlyContinue'

$ws       = 'C:\Users\Dell\Desktop\workspace\1xauto'
$pidDir   = Join-Path $ws 'shards'
$stopFlag = Join-Path $ws '.pipeline-stop'

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

function Stop-Tree([int]$processId, [string]$label) {
    if (-not (Test-Alive $processId)) { return $false }
    & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
    Write-Host ("[pipeline] stopped {0} (PID {1})" -f $label, $processId) -ForegroundColor DarkYellow
    return $true
}

$stopped = 0

# 1. Scrapers and the ledger sync. Stopping these first means the monitor sees
#    no new work while it is closing, so it cannot raise a stale-work alert.
foreach ($name in @('shard-1', 'shard-2', 'melbet', 'telegram-sync')) {
    if (Stop-Tree (Get-Pid $name) $name) { $stopped++ }
}

# 2. The supervisor, politely.
$supervisor = Get-Pid 'monitor-supervisor'
if (Test-Alive $supervisor) {
    Set-Content -Path $stopFlag -Value 'stop' -Encoding ASCII
    $deadline = (Get-Date).AddSeconds([Math]::Max(1, $GraceSeconds))
    while ((Test-Alive $supervisor) -and ((Get-Date) -lt $deadline)) {
        Start-Sleep -Milliseconds 200
    }
    if (Test-Alive $supervisor) {
        if (Stop-Tree $supervisor 'monitor-supervisor') { $stopped++ }
    } else {
        Write-Host '[pipeline] monitor closed cleanly (notice sent to Telegram)' -ForegroundColor DarkYellow
        $stopped++
    }
}

# 3. Orphans. Killing a parent does not kill its children on Windows, so a
#    supervisor that was force-killed earlier can leave the agent behind.
$orphans = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'scripts[\\/]monitor-agent\.mjs' }
foreach ($orphan in $orphans) {
    if (Stop-Tree $orphan.ProcessId 'monitor-agent (orphan)') { $stopped++ }
}

# 4. The wrapper last: it owns a kill-on-close job, so ending it takes any
#    escaped child with it. Killing the PowerShell only hands control back to
#    the cmd.exe that ran start-all.bat, which then sits at its error prompt;
#    take that window down too so "stop" really means stopped.
$wrapper = Get-Pid 'pipeline'
if ($All -and (Test-Alive $wrapper) -and $wrapper -ne $PID) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$wrapper" |
        ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" }
    if (Stop-Tree $wrapper 'start-all.bat') { $stopped++ }
    if ($parent -and $parent.Name -eq 'cmd.exe' -and $parent.CommandLine -match 'start-all' -and $parent.ProcessId -ne $PID) {
        Start-Sleep -Milliseconds 500
        if (Test-Alive $parent.ProcessId) {
            & taskkill.exe /PID $parent.ProcessId /T /F 2>$null | Out-Null
            Write-Host ("[pipeline] closed the start-all.bat window (PID {0})" -f $parent.ProcessId) -ForegroundColor DarkYellow
        }
    }
}

Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue
foreach ($name in @('shard-1', 'shard-2', 'melbet', 'telegram-sync', 'monitor-supervisor', 'pipeline')) {
    Remove-Item (Join-Path $pidDir "$name.pid") -Force -ErrorAction SilentlyContinue
}

# Locks left behind by a forced kill are harmless (they check the PID), but
# clearing them keeps /status and ps output honest.
Remove-Item (Join-Path $ws 'status-bot.pid') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $ws 'monitor-supervisor.pid') -Force -ErrorAction SilentlyContinue

if ($stopped -eq 0) {
    Write-Host '[pipeline] nothing was running' -ForegroundColor DarkGray
} else {
    Write-Host ("[pipeline] stopped {0} service(s)" -f $stopped) -ForegroundColor Yellow
}
