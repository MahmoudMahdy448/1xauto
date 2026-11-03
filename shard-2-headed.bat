@echo off
rem shard-2-headed.bat - run 1xbet shard 2 alone, with a VISIBLE browser.
rem
rem   shard-2-headed.bat            fresh pass at the range start (account 150)
rem   shard-2-headed.bat -Resume    continue where the saved state stopped
rem   shard-2-headed.bat -AccountDelayMs 15000   slower pacing (lower block risk)
rem
rem It refuses while the farm is running (stop-all.bat first). Ledger sync and
rem the monitor are not started: this is one shard, not the pipeline. Press Q to
rem stop it.

setlocal EnableExtensions
cd /d "%~dp0"
title 1xauto shard-2 (headed)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-shard-headed.ps1" -Name shard-2 %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [shard-2] exited with code %RC%.
  pause
)

exit /b %RC%
