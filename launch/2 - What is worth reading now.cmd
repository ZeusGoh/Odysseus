@echo off
REM Free. No model calls. Shows what the gate thinks has actually happened.
cd /d "%~dp0.."
title Odysseus - what is worth reading
echo Checking the board. This costs nothing - no analyst is run.
echo.
node mcp\watch.js --dry-run
echo.
pause
