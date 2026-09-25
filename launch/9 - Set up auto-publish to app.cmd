@echo off
REM Do this ONCE. Saves your Cloud login locally so reports can publish
REM themselves - no password prompt possible in an hourly scheduled task.
cd /d "%~dp0.."
title Odysseus - set up auto-publish
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\claude\setup-cloud-credentials.ps1"
echo.
pause
