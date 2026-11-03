@echo off
rem demo.bat - the boss demo in one double-click.
rem
rem What it does:
rem   1. refuses to run if 1xbet is still blocking this IP
rem   2. pauses the real farm so the browser and dashboard are alone
rem   3. opens the live control room (http://127.0.0.1:8787/)
rem   4. runs three known-good accounts in a VISIBLE browser
rem   5. keeps the dashboard on screen, then restores shard-2 on Enter
rem
rem Real ledger, real Telegram channel. Duplicates show as "already seen" -
rem that is the dedup rail working, not a failure.
rem
rem   demo.bat                   default 3 accounts, 15 s pacing
rem   demo.bat -NoRestart        leave the farm stopped afterwards
rem   demo.bat -SkipPause        do not stop the farm first (not recommended)

setlocal EnableExtensions
cd /d "%~dp0"
title 1xauto boss demo

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-demo.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [demo] exited with code %RC%.
  pause
)

exit /b %RC%
