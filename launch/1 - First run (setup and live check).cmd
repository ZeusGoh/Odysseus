@echo off
REM One-time setup, then prove everything works against the real Bybit API.
cd /d "%~dp0.."
title Odysseus - first run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\claude\run-analyst.ps1"
echo.
echo Log: %~dp0..\verdicts\first-run.log
pause
