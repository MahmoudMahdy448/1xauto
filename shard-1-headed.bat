@echo off
rem shard-1-headed.bat - run 1xbet shard 1 alone, with a VISIBLE browser.
rem
rem   shard-1-headed.bat            fresh pass at the range start (account 1)
rem   shard-1-headed.bat -Resume    continue where the saved state stopped
rem
rem It refuses while the farm is running (stop-all.bat first). The monitor is
rem not started: this is one shard, not the pipeline. Press Q to stop it.
rem
rem NOTE: shard-1 is accounts 1-276. Use it to retest that range on its own.

setlocal EnableExtensions
cd /d "%~dp0"
title 1xauto shard-1 (headed)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-shard-headed.ps1" -Name shard-1 %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [shard-1] exited with code %RC%.
  pause
)

exit /b %RC%
