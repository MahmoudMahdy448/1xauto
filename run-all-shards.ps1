# run-all-shards.ps1
# Launches all three scrapers in parallel (hidden PowerShell processes, logs on disk).
#
#   shard-1 : 1xauto accounts 1-276 (the whole 1xbet list)
#   melbet  : melbet-autologin (own accounts.csv, 1 browser)
#   linebet : Linebet-autologin (own accounts.csv, 1 browser)
#
# All three share ONE seen-numbers ledger so a phone number is sent to Telegram
# exactly once, ever - across sites and across loops.
#
# Each loop cools down 90 minutes between batches.
#
# Every shard is started through scripts\launch-shard.ps1, the same definition
# the admin bot uses for /restart. The monitor supervisor then starts the event
# agent and the status bot.
#
# Usage: .\run-all-shards.ps1 [-Resume] [-Headed] [-AccountDelayMs N]
#   -Resume  continue each shard at the account it last reached (used when
#            swapping a running pipeline to this launcher) instead of starting
#            a fresh pass at the shard's range start.
#   -Headed  show the three browsers (used by start-all-headed.bat).

param(
    [switch]$Resume,

    # Show the three browsers instead of running them headless. The consoles
    # stay hidden and the logs are still on disk.
    [switch]$Headed,

    # Pause between accounts for every shard. Default is 5 s on all three
    # scrapers; set it explicitly when you want a different value.
    [int]$AccountDelayMs = 5000
)

$ErrorActionPreference = 'Stop'

$ws         = 'C:\Users\Dell\Desktop\workspace\1xauto'
$ledger     = Join-Path $ws 'seen-numbers.json'
$eventsDir  = Join-Path $ws 'events'
$logDir     = Join-Path $ws 'logs'
$pidDir     = Join-Path $ws 'shards'
$launch     = Join-Path $ws 'scripts\launch-shard.ps1'
$pwsh       = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

New-Item -ItemType Directory -Force -Path $logDir, $eventsDir, $pidDir | Out-Null

function Start-Loop {
    param(
        [string]$Name,
        [string]$WorkDir,
        [string]$Command
    )

    $out = Join-Path $logDir "$Name.log"
    $err = Join-Path $logDir "$Name.err.log"

    $full = "`$Host.UI.RawUI.WindowTitle = '$Name'; Set-Location '$WorkDir'; $Command"

    $proc = Start-Process -FilePath $pwsh `
        -ArgumentList '-NoProfile', '-Command', $full `
        -RedirectStandardOutput $out `
        -RedirectStandardError $err `
        -WindowStyle Hidden `
        -PassThru

    Write-Host ("[{0}] started (PID {1}) -> {2}" -f $Name, $proc.Id, $out) -ForegroundColor Green
    return $proc
}

foreach ($shard in @('shard-1', 'melbet', 'linebet')) {
    & $launch -Name $shard -Resume:$Resume.IsPresent -Headed:$Headed.IsPresent -AccountDelayMs $AccountDelayMs
}

# Starts the monitor agent and the status bot, and keeps them alive.
$supervisorProc = Start-Loop -Name 'monitor-supervisor' -WorkDir $ws -Command "node scripts/monitor-supervisor.mjs"
Set-Content -Path (Join-Path $pidDir 'monitor-supervisor.pid') -Value $supervisorProc.Id -Encoding ASCII

Write-Host ''
Write-Host 'All 3 shards launched (plus the monitor).' -ForegroundColor Cyan
Write-Host "Shared ledger: $ledger"
Write-Host 'Monitor with:    .\monitor.ps1'
Write-Host 'Tail logs with:  Get-Content logs\shard-1.log -Wait'
