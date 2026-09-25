@echo off
REM Removes the automatic pass. Nothing runs by itself after this.
cd /d "%~dp0.."
title Odysseus - stop automatic watching
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\claude\register-watch.ps1" -Remove
echo.
pause
