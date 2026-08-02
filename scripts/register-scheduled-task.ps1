# Register a Windows Scheduled Task that runs the BetJam/1xauto batch every 60 minutes.
# Run from PowerShell (no admin needed for the current user):
#   powershell -ExecutionPolicy Bypass -File scripts\register-scheduled-task.ps1
# Remove with:
#   Unregister-ScheduledTask -TaskName "1xauto-scheduled-run" -Confirm:$false

$TaskName = "1xauto-scheduled-run"
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$NodeExe = (Get-Command node).Source
$Action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$ProjectDir\scripts\scheduled-run.mjs`"" -WorkingDirectory $ProjectDir
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 60) -RepetitionDuration (New-TimeSpan -Days 3650)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Run 1xauto login batch + excel + Telegram notify every 60 minutes" -Force

Write-Host "Registered scheduled task '$TaskName'. Check with: Get-ScheduledTask -TaskName '$TaskName'"
