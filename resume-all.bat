@echo off
rem resume-all.bat - start the pipeline and continue each shard at the account
rem it last reached, instead of starting the pass again from the first account.
rem Same thing as:  start-all.bat -Resume

call "%~dp0start-all.bat" -Resume
exit /b %ERRORLEVEL%
