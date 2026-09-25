@echo off
REM Runs the two blind analysts on whatever the gate picked.
REM Uses your Claude subscription. Nothing is sent to the app.
cd /d "%~dp0.."
title Odysseus - running the analysts
echo Running the two blind analysts on whatever has actually moved.
echo This can take a few minutes per coin.
echo.
node mcp\watch.js --no-publish
echo.
pause
