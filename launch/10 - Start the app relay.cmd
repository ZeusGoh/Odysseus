@echo off
REM Starts the small relay the buttons in Odysseus -> Analyst talk to. It opens
REM minimised and stays running; close its window to stop it. It launches only
REM the same commands these launchers run, holds no key, and answers only to
REM this machine.
cd /d "%~dp0.."
where node >nul 2>&1 || (echo node is not installed. & pause & exit /b)
start "Odysseus relay - leave open" /min node mcp\panel.js
echo Relay started (minimised). Open Odysseus - Analyst: the strip should say "relay on".
timeout /t 4 >nul
