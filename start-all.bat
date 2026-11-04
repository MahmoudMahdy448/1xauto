@echo off
rem start-all.bat - start the complete 1xauto pipeline in this one window.
rem
rem   scrapers : shard-1 (all 1xbet accounts) + melbet (all) + linebet (all)
rem              (each loop starts its own realtime sender for the batch, and
rem              stops it when the batch ends; all three share one ledger)
rem   monitor  : monitor-supervisor.mjs -> monitor agent + status bot
rem
rem Press Q (or Ctrl+C, or close this window) to stop everything.
rem Closing the window still stops the children: they run in a Windows job
rem object that is killed when this console ends.
rem
rem   start-all.bat              fresh pass at each shard's range start
rem   start-all.bat -Resume      continue where each shard last was
rem   start-all.bat -Restart     stop a running pipeline, then start

setlocal EnableExtensions
cd /d "%~dp0"
title 1xauto pipeline

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-pipeline.ps1" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [pipeline] exited with code %RC%.
  pause
)

exit /b %RC%
