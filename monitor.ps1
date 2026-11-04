<#
.SYNOPSIS
  Live status of the scraper + Telegram pipeline.

.DESCRIPTION
  Refreshes every few seconds and shows:
    - which jobs are alive (loops, realtime senders)
    - per shard: state, batch results, next run countdown, watcher status
    - sending: numbers sent / skipped this batch, failures, last number
    - ledger: total numbers and when it last changed

.EXAMPLE
  .\monitor.ps1
  .\monitor.ps1 -IntervalSeconds 10
  .\monitor.ps1 -Once
#>

param(
  [int]$IntervalSeconds = 5,
  [switch]$Once
)

$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$ws = $root
$melbetDir = Join-Path (Split-Path $root -Parent) 'melbet-autologin'
$linebetDir = Join-Path (Split-Path $root -Parent) 'Linebet-autologin'

function Get-LogText([string]$path) {
  if (-not (Test-Path $path)) { return '' }
  return (Get-Content $path -Raw)
}

# Only the part of the log written since the current realtime watcher started,
# so the counters describe the batch that is running now.
function Get-CurrentBatch([string]$raw) {
  if (-not $raw) { return '' }
  $i = $raw.LastIndexOf('[realtime-send] Watching')
  if ($i -lt 0) { return $raw }
  return $raw.Substring($i)
}

function Count-Matches([string]$text, [string]$pattern) {
  if (-not $text) { return 0 }
  return ([regex]::Matches($text, $pattern)).Count
}

function Read-Json([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  try { return (Get-Content $path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-WatcherState([string]$raw) {
  if (-not $raw) { return 'not started' }
  $start = $raw.LastIndexOf('[realtime-send] Watching')
  if ($start -lt 0) { return 'not started' }
  $stop = [Math]::Max($raw.LastIndexOf('[scheduled-run] realtime-send stopped'), $raw.LastIndexOf('Parent process is gone'))
  if ($stop -gt $start) { return 'stopped' }
  return 'running'
}

function Get-Jobs {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
  $jobs = @{ loops = 0; senders = 0 }
  foreach ($p in $procs) {
    $cmd = $p.CommandLine
    if (-not $cmd) { continue }
    if ($cmd -match 'run-loop\.js' -or $cmd -match 'scheduled-run\.mjs') { $jobs.loops++ }
    elseif ($cmd -match 'realtime-send\.mjs') { $jobs.senders++ }
  }
  return $jobs
}

function Format-Age($iso) {
  if (-not $iso) { return '-' }
  try {
    $when = [datetime]::Parse($iso, [System.Globalization.CultureInfo]::InvariantCulture,
      [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
    $span = [datetime]::UtcNow - $when.ToUniversalTime()
    if ($span.TotalSeconds -lt 0) {
      $span = $span.Negate()
      return ('in {0}h {1:00}m' -f [int][math]::Floor($span.TotalHours), $span.Minutes)
    }
    if ($span.TotalHours -ge 1) { return ('{0}h {1:00}m ago' -f [int][math]::Floor($span.TotalHours), $span.Minutes) }
    return ('{0}m ago' -f [int][math]::Floor($span.TotalMinutes))
  } catch { return '-' }
}

function Show-Dashboard {
  Clear-Host
  $now = Get-Date
  $jobs = Get-Jobs
  $ledger = Read-Json (Join-Path $ws 'seen-numbers.json')

  $shards = @(
    @{ name = 'shard-1 (1-276)';   log = 'logs\shard-1.log'; status = 'loop-status-shard-1.json'; summary = 'run-summary-shard-1.json'; dir = $ws },
    @{ name = 'melbet';            log = 'logs\melbet.log';  status = 'loop-status.json';         summary = 'run-summary.json';         dir = $melbetDir },
    @{ name = 'linebet';           log = 'logs\linebet.log'; status = 'loop-status.json';         summary = 'run-summary.json';         dir = $linebetDir }
  )
  foreach ($s in $shards) {
    $s.raw = Get-LogText (Join-Path $ws $s.log)
    $s.statusJson = Read-Json (Join-Path $s.dir $s.status)
    $s.summaryJson = Read-Json (Join-Path $s.dir $s.summary)
    $s.watcher = Get-WatcherState $s.raw
    $s.active = ($s.statusJson -and $s.statusJson.state -ne 'cooldown')
  }
  $expectedSenders = ($shards | Where-Object { $_.active }).Count

  Write-Host ''
  Write-Host ("  1XAUTO  ·  {0}" -f $now.ToString('yyyy-MM-dd HH:mm:ss')) -ForegroundColor White
  Write-Host ''

  # --- jobs -------------------------------------------------------------
  function Job-Line($label, $count, $expected) {
    if ($count -ge $expected) {
      Write-Host ("  {0,-18} {1}/{2} running" -f $label, $count, $expected) -ForegroundColor Green
    } else {
      Write-Host ("  {0,-18} {1}/{2} running   <-- MISSING" -f $label, $count, $expected) -ForegroundColor Red
    }
  }
  Job-Line 'scraping loops' $jobs.loops 3
  if ($expectedSenders -eq 0) {
    Write-Host ("  {0,-18} idle (all batches cooling down)" -f 'realtime senders') -ForegroundColor DarkGray
  } else {
    Job-Line 'realtime senders' $jobs.senders $expectedSenders
  }

  # --- ledger -----------------------------------------------------------
  Write-Host ''
  $ledgerCount = if ($ledger -and $ledger.numbers) { $ledger.numbers.Count } else { 0 }
  Write-Host ("  Ledger            {0:N0} numbers  (updated {1})" -f $ledgerCount, (Format-Age $ledger.updatedAt))

  # --- shards -----------------------------------------------------------
  foreach ($s in $shards) {
    $batch = Get-CurrentBatch $s.raw
    $sent = Count-Matches $batch 'realtime-send\] SENT'
    $skip = Count-Matches $batch 'SKIP \(already seen\)'
    $fail = Count-Matches $batch 'Failed to send|Released |Ledger claim failed|Scan error'

    Write-Host ''
    Write-Host ("  {0}" -f $s.name) -ForegroundColor Cyan

    if ($s.statusJson) {
      $state = $s.statusJson.state
      $extra = ''
      if ($state -eq 'cooldown' -and $s.statusJson.nextRunAt) { $extra = "   next run $(Format-Age $s.statusJson.nextRunAt)" }
      $col = if ($state -eq 'cooldown') { 'Gray' } else { 'Green' }
      Write-Host ("    state           {0}  (run #{1}){2}" -f $state, $s.statusJson.run, $extra) -ForegroundColor $col
    } else {
      Write-Host '    state           no status file' -ForegroundColor Yellow
    }

    if ($s.summaryJson) {
      Write-Host ("    last batch      {0} ok / {1} failed  ·  {2} unique numbers  ·  {3:N0} min" -f `
        $s.summaryJson.succeeded, $s.summaryJson.failed, $s.summaryJson.uniqueNumbers, ($s.summaryJson.durationMs / 60000))
    }

    $wcol = if ($s.watcher -eq 'running') { 'Green' } elseif ($s.watcher -eq 'stopped') { 'DarkGray' } else { 'Yellow' }
    Write-Host ("    watcher         {0}   sent {1}   skipped {2}   failures {3}" -f $s.watcher, $sent, $skip, $fail) `
      -ForegroundColor $(if ($fail -gt 0) { 'Red' } else { $wcol })

    $lastSent = ($batch -split "`n" | Where-Object { $_ -match 'realtime-send\] SENT' } | Select-Object -Last 1)
    if ($lastSent) { Write-Host ("    last sent       {0}" -f $lastSent.Trim()) -ForegroundColor DarkGray }
  }

  Write-Host ''
  Write-Host '  Ctrl+C to stop monitoring (the jobs keep running).' -ForegroundColor DarkGray
  Write-Host ''
}

if ($Once) {
  Show-Dashboard
} else {
  while ($true) {
    Show-Dashboard
    Start-Sleep -Seconds $IntervalSeconds
  }
}
