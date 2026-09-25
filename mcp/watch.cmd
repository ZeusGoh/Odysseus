@echo off
REM watch.cmd — one unattended pass, for Windows Task Scheduler.
REM
REM Registered by claude\register-watch.ps1 (launch\6, or the app's Start auto
REM button): every 30 minutes, through watch-hidden.vbs so no window shows.
REM
REM Task Scheduler runs with a much smaller PATH than a login shell, so if the
REM task logs 'could not start "claude"', set ODYSSEUS_CLAUDE_BIN below to the
REM full path that `where claude` prints in a normal terminal.
REM
REM Everything it does is appended to verdicts\watch.log.

setlocal
cd /d "%~dp0.."

REM The native installer puts claude here and does NOT add it to the system
REM PATH, so a scheduled task often cannot find it even though `claude` works
REM fine in your own terminal. Point at it directly when it is there; fall back
REM to whatever is on PATH when it is not.
if exist "%USERPROFILE%\.local\bin\claude.exe" set "ODYSSEUS_CLAUDE_BIN=%USERPROFILE%\.local\bin\claude.exe"

node mcp\watch.js --quiet %*
exit /b %ERRORLEVEL%
