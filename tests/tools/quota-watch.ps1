# quota-watch.ps1
# Samples total bytes on the primary network adapter so a 12-hour ADSL quota
# delta can be attributed to a workload instead of guessed.
#
#   powershell -NoProfile -File tests\tools\quota-watch.ps1
#   powershell -NoProfile -File tests\tools\quota-watch.ps1 -Hours 1 -IntervalSeconds 60
#
# Appends one CSV row per interval to metrics\net-samples.csv. Counters are
# cumulative; deltas are computed at analysis time, so a restart of this script
# does not lose the baseline.

param(
    [int]$IntervalSeconds = 300,
    [double]$Hours = 12.5
)

$ErrorActionPreference = 'SilentlyContinue'
$ws = 'C:\Users\Dell\Desktop\workspace\1xauto'
$out = Join-Path $ws 'metrics\net-samples.csv'
$inv = [Globalization.CultureInfo]::InvariantCulture

New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
if (-not (Test-Path $out)) {
    'ts_utc,rx_bytes,tx_bytes,shard1_success,shard2_success,melbet_accounts,melbet_screenshots,chrome_procs,cache1_mb,cache2_mb,pipeline_alive' |
        Set-Content -Path $out -Encoding ASCII
}

function Count-Lines([string]$path, [string]$pattern) {
    if (-not (Test-Path $path)) { return 0 }
    return @(Select-String -Path $path -Pattern $pattern -SimpleMatch).Count
}

function Dir-MB([string]$path) {
    if (-not (Test-Path $path)) { return 0 }
    $sum = (Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    if (-not $sum) { return 0 }
    return [math]::Round($sum / 1MB, 2)
}

$deadline = (Get-Date).AddHours($Hours)

while ((Get-Date) -lt $deadline) {
    try {
        $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1
        $stats = $null
        if ($route) {
            $adapter = Get-NetAdapter -InterfaceIndex $route.ifIndex
            if ($adapter) { $stats = Get-NetAdapterStatistics -Name $adapter.Name }
        }

        $rx = if ($stats) { $stats.ReceivedBytes } else { 0 }
        $tx = if ($stats) { $stats.SentBytes } else { 0 }

        $pipelinePid = 0
        $pidFile = Join-Path $ws 'shards\pipeline.pid'
        if (Test-Path $pidFile) { $pipelinePid = [int](Get-Content $pidFile -Raw) }
        $alive = if ($pipelinePid -gt 0 -and (Get-Process -Id $pipelinePid -ErrorAction SilentlyContinue)) { 1 } else { 0 }

        $row = @(
            (Get-Date).ToUniversalTime().ToString('o', $inv)
            $rx
            $tx
            (Count-Lines (Join-Path $ws 'logs\shard-1.log') 'success for')
            (Count-Lines (Join-Path $ws 'logs\shard-2.log') 'success for')
            (Count-Lines (Join-Path $ws 'logs\melbet.log') 'Signing in with')
            (Count-Lines (Join-Path $ws 'logs\melbet.log') 'Screenshot saved to')
            @(Get-Process -Name chrome-headless-shell -ErrorAction SilentlyContinue).Count
            (Dir-MB (Join-Path $ws '.browser-cache\shard-1'))
            (Dir-MB (Join-Path $ws '.browser-cache\shard-2'))
            $alive
        ) -join ','

        Add-Content -Path $out -Value $row -Encoding ASCII
    } catch {
        Add-Content -Path (Join-Path $ws 'metrics\net-samples-errors.log') -Value ("{0} {1}" -f (Get-Date).ToString('o'), $_.Exception.Message)
    }

    Start-Sleep -Seconds $IntervalSeconds
}
