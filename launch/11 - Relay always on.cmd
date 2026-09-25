@echo off
REM Makes the app relay start by itself, at every logon, with no window - so
REM the buttons in Odysseus -> Analyst just work, and launch\10 is never
REM needed again. Starts it right now too. Its output goes to
REM verdicts\relay.log. launch\12 turns it back off.
cd /d "%~dp0.."
title Odysseus - relay always on
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\claude\register-relay.ps1"
echo.
pause
