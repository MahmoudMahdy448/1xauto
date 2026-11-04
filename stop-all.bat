@echo off
rem stop-all.bat - stop the pipeline started by start-all.bat.
rem
rem Kills the scrapers, the monitor supervisor (with the agent and the status
rem bot it owns) and finally the start-all.bat window itself.
rem Safe to run when nothing is running.

setlocal EnableExtensions
cd /d "%~dp0"
title 1xauto pipeline - stopping

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-pipeline.ps1" -All

echo.
pause
exit /b 0
