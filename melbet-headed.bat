@echo off
rem melbet-headed.bat - run the melbet shard alone, with a VISIBLE browser.
rem
rem   melbet-headed.bat              fresh pass at the range start
rem   melbet-headed.bat -Resume      continue where the saved state stopped
rem
rem Melbet runs ONE browser, matching start-all-headed.bat.
rem
rem It refuses while the farm is running (stop-all.bat first). The monitor is
rem not started: this is one shard, not the pipeline. Press Q to stop it.
rem
rem Melbet uses the shared ledger (seen-numbers.json), so a number it captures
rem is never posted twice by the 1xbet shards.

setlocal EnableExtensions
cd /d "%~dp0"
title 1xauto melbet (headed)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-shard-headed.ps1" -Name melbet %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [melbet] exited with code %RC%.
  pause
)

exit /b %RC%
