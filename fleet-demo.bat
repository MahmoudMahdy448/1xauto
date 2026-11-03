@echo off
rem fleet-demo.bat - the boss demo, fleet edition, in one double-click.
rem
rem What it does:
rem   1. refuses if the 1xbet IP breaker is armed or the deposit gate is shut
rem   2. pauses the real farm so the three demo browsers are alone
rem   3. opens the fleet control room (http://127.0.0.1:8787/)
rem   4. runs TWO 1xbet shards and ONE melbet shard at the same time
rem   5. keeps the dashboard on screen, then restores shard-2 on Enter
rem
rem Real ledger, real Telegram channel for both 1xbet shards. Melbet is
rem extract-only because its ledger is behind and would re-post history.
rem Duplicates show as "already seen" - that is the dedup rail working.
rem
rem   fleet-demo.bat                    3 accounts per 1xbet shard, 2 melbet
rem   fleet-demo.bat -NoRestart          leave the farm stopped afterwards
rem   fleet-demo.bat -NoOpen             do not open a browser automatically
rem   fleet-demo.bat -SkipPause          do not stop the farm first (not recommended)

setlocal EnableExtensions
cd /d "%~dp0"
title 1xauto fleet demo

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-fleet-demo.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [demo] exited with code %RC%.
  pause
)

exit /b %RC%
