@echo off
REM Registers the automatic pass: every 30 minutes, hidden, while this PC is
REM awake. (The file is still called "hourly" - the interval lives in
REM claude\register-watch.ps1, default 30.) A pass missed while the machine
REM was asleep runs as soon as it wakes.
cd /d "%~dp0.."
title Odysseus - start automatic watching
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\claude\register-watch.ps1" -Minutes 30
echo.
pause
