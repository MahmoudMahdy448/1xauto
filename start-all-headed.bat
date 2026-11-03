@echo off
rem start-all-headed.bat - the complete 1xauto pipeline, with VISIBLE browsers.
rem
rem Exactly the same services as start-all.bat:
rem
rem   scrapers : shard-1 + shard-2 + melbet (each loop starts its own realtime
rem              sender for the batch, and stops it when the batch ends)
rem   sync     : telegram-sync-loop.mjs, keeps the ledger equal to the channel
rem   monitor  : monitor-supervisor.mjs -> monitor agent + status bot
rem
rem The only difference is that the three browsers are shown on screen:
rem shard-1 (accounts 1-149), shard-2 (accounts 150-276) and melbet, one each.
rem The consoles stay hidden and the logs still go to logs\<name>.log.
rem
rem Headed uses noticeably more RAM: 3 visible Chromium trees on 8 GB is close
rem to the ceiling. If browsers start dying, stop the farm and raise the pacing:
rem   start-all-headed.bat -Restart -AccountDelayMs 15000
rem
rem Press Q (or Ctrl+C, or close this window) to stop everything.
rem
rem   start-all-headed.bat              fresh pass at each shard's range start
rem   start-all-headed.bat -Resume      continue where each shard last was
rem   start-all-headed.bat -Restart     stop a running pipeline, then start

setlocal EnableExtensions
cd /d "%~dp0"
title 1xauto pipeline (headed)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-pipeline.ps1" -Headed %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [pipeline] exited with code %RC%.
  pause
)

exit /b %RC%
