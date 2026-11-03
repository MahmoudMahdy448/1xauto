@echo off
rem restart-all.bat - stop whatever pipeline is running, then start a fresh one.
rem Same thing as:  start-all.bat -Restart
rem Use it when the old window is gone but the services are still alive, or when
rem you want a clean pass from the first account in each shard's range.

call "%~dp0start-all.bat" -Restart
exit /b %ERRORLEVEL%
