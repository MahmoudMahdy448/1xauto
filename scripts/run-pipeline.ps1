# run-pipeline.ps1
# Owns the whole pipeline for start-all.bat.
#
# It starts the 3 scrapers, the ledger sync and the monitor supervisor through
# run-all-shards.ps1 (which in turn uses scripts\launch-shard.ps1, the same
# definition /restart uses), then waits. When this process ends - Q, Ctrl+C, or
# the console window being closed - every descendant is killed.
#
# The guarantee comes from a Windows job object with KILL_ON_JOB_CLOSE: the
# children are in the job, and the kernel terminates them when the job handle
# closes, including on a hard kill where no PowerShell cleanup code can run.
#
# The per-batch realtime sender is not started here: scripts\scheduled-run.mjs
# starts it before every Playwright run and stops it after, so it inherits the
# job through the shard loop.
#
# Usage: powershell -NoProfile -File scripts\run-pipeline.ps1 [-Resume] [-Restart] [-Headed] [-AccountDelayMs N]

param(
    # Continue each shard at the account it last reached instead of restarting
    # the pass at the shard's range start.
    [switch]$Resume,

    # Stop a running pipeline first instead of refusing to start a second one.
    [switch]$Restart,

    # Show the browsers. Everything else (sync, monitor, job object, Q to stop)
    # behaves exactly like the headless launcher.
    [switch]$Headed,

    # Pause between accounts, applied to every shard. 0 keeps the defaults.
    [int]$AccountDelayMs = 0
)

$ErrorActionPreference = 'Stop'

$ws     = 'C:\Users\Dell\Desktop\workspace\1xauto'
$pidDir = Join-Path $ws 'shards'
$stopScript = Join-Path $ws 'scripts\stop-pipeline.ps1'

New-Item -ItemType Directory -Force -Path $pidDir | Out-Null

# A stop flag left by an interrupted shutdown must not stop this new run.
Remove-Item (Join-Path $ws '.pipeline-stop') -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# One pipeline at a time
# ---------------------------------------------------------------------------

$managed = @('shard-1', 'shard-2', 'melbet', 'telegram-sync', 'monitor-supervisor')

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

$alive = @()
foreach ($name in $managed) {
    $processId = Get-Pid $name
    if (Test-Alive $processId) { $alive += "$name (PID $processId)" }
}
if (Test-Alive (Get-Pid 'pipeline')) {
    $alive = @("start-all.bat (PID $(Get-Pid 'pipeline'))") + $alive
}

if ($alive.Count -gt 0) {
    if (-not $Restart) {
        Write-Host '[pipeline] already running:' -ForegroundColor Yellow
        foreach ($line in $alive) { Write-Host "  - $line" }
        Write-Host ''
        Write-Host 'Stop it with stop-all.bat, or start with:  start-all.bat -Restart'
        exit 1
    }
    Write-Host '[pipeline] -Restart: stopping the running pipeline first' -ForegroundColor Yellow
    & $stopScript
}

# ---------------------------------------------------------------------------
# Kill-on-close job: the children cannot outlive this console
# ---------------------------------------------------------------------------

if (-not ('PipelineJob' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class PipelineJob
{
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    public static IntPtr Create()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        int size = Marshal.SizeOf(info);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        if (!AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
        {
            return IntPtr.Zero;
        }
        return job;
    }
}
'@
}

$job = [PipelineJob]::Create()
if ($job -eq [IntPtr]::Zero) {
    Write-Host '[pipeline] warning: could not join the kill-on-close job; closing the window may leave children behind' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

Set-Content -Path (Join-Path $pidDir 'pipeline.pid') -Value $PID -Encoding ASCII

Write-Host ''
Write-Host '  1xauto pipeline' -ForegroundColor Cyan
Write-Host ("  shard-1 + shard-2 + melbet, ledger sync, monitor agent and status bot" + $(if ($Headed) { ' — HEADED' } else { '' }))
Write-Host '  1xbet: 1 browser per shard (accounts split 1-149 / 150-276) · melbet: 1'
Write-Host ''

try {
    & (Join-Path $ws 'run-all-shards.ps1') -Resume:$Resume -Headed:$Headed -AccountDelayMs $AccountDelayMs
} catch {
    Write-Host ("[pipeline] start failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    & $stopScript
    Remove-Item (Join-Path $pidDir 'pipeline.pid') -Force -ErrorAction SilentlyContinue
    exit 1
}

Start-Sleep -Seconds 8

# A shard that died immediately is worth reporting before the user walks away.
$dead = @()
foreach ($name in $managed) {
    if (-not (Test-Alive (Get-Pid $name))) { $dead += $name }
}

Write-Host ''
if ($dead.Count -gt 0) {
    Write-Host ("[pipeline] not running: {0}" -f ($dead -join ', ')) -ForegroundColor Red
    Write-Host '           check logs\<name>.log and logs\<name>.err.log'
} else {
    Write-Host '[pipeline] all services running' -ForegroundColor Green
}
Write-Host ''
Write-Host '  press Q to stop everything (Ctrl+C or closing this window works too)'
Write-Host '  live view: .\monitor.ps1      logs: logs\<name>.log'
Write-Host ''

$lastStatus = Get-Date
# ReadKey throws when the console has no keyboard (redirected input, a service).
$canReadKeys = $true
try { [void][Console]::KeyAvailable } catch { $canReadKeys = $false }

while ($true) {
    if ($canReadKeys -and [Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq 'Q') {
            Write-Host ''
            Write-Host '[pipeline] stopping...' -ForegroundColor Yellow
            break
        }
        if ($key.Key -eq 'S') {
            $up = @()
            foreach ($name in $managed) {
                $processId = Get-Pid $name
                $mark = if (Test-Alive $processId) { 'up  ' } else { 'DOWN' }
                $up += ("{0} {1,-18} {2}" -f $mark, $name, $processId)
            }
            Write-Host ($up -join "`n")
            $lastStatus = Get-Date
        }
    }

    if (((Get-Date) - $lastStatus).TotalSeconds -ge 60) {
        $count = 0
        foreach ($name in $managed) {
            if (Test-Alive (Get-Pid $name)) { $count++ }
        }
        Write-Host ("[{0}] pipeline alive: {1}/{2} services" -f (Get-Date -Format 'HH:mm:ss'), $count, $managed.Count)
        $lastStatus = Get-Date
    }

    Start-Sleep -Milliseconds 400
}
