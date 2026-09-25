@echo off
REM Undoes launch\11: removes the always-on task and stops the relay it is
REM running. After this the relay runs only while a launch\10 window is open.
cd /d "%~dp0.."
title Odysseus - relay off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\claude\register-relay.ps1" -Remove
echo.
pause
