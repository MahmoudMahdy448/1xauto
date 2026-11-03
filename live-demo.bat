@echo off
rem live-demo.bat - control panel for the manager meeting.
rem
rem Opens http://127.0.0.1:8788/ where you can start/stop each headed service
rem (1xbet shard 1, 1xbet shard 2, melbet, betjam, fastpari, lilbet, linebet,
rem paripulse) on its own, all five external autologins, or all eight at once.
rem The panel shows laptop CPU/RAM, per-service CPU/RAM, the one-service vs
rem fleet comparison, live screenshots, and dial -> Telegram latency.
rem
rem Demo only: fresh demo ledger, Telegram admin chat only (channel off),
rem production state and screenshots untouched.

setlocal EnableExtensions
cd /d "%~dp0"
title 1xauto live demo

node scripts\live-demo.mjs --port 8788 --open
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [live-demo] exited with code %RC%.
  pause
)

exit /b %RC%
