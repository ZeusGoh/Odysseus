@echo off
REM Pushes verdicts\latest.json into the app's Analyst view via Cloud sync.
cd /d "%~dp0.."
title Odysseus - publish to the app
if not exist "verdicts\latest.json" echo No report yet - run 3 or 4 first. & pause & exit /b
node mcp\publish.js verdicts\latest.json
echo.
pause
