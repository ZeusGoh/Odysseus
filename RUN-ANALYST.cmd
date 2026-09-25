@echo off
REM RUN-ANALYST.cmd — double-click this.
REM
REM Puts the Claude Code config in place, runs the test suite, checks the engine
REM against the real Bybit API, shows what is worth reading right now, and then
REM runs the two blind analysts once.
REM
REM Everything is written to verdicts\first-run.log. Send that file back to
REM Claude if anything fails.

cd /d "%~dp0"
title Odysseus analyst - first run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude\run-analyst.ps1" %*

echo.
echo ---------------------------------------------------------------
echo Finished. The full log is at:
echo   %~dp0verdicts\first-run.log
echo ---------------------------------------------------------------
echo.
pause
