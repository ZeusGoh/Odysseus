@echo off
REM INSTALL-CLAUDE-CODE.cmd -- double-click this once.
REM
REM Installs the Claude Code CLI (the `claude` command) so the two analysts
REM can actually run. This is the one thing verdicts\first-run.log found
REM missing: `claude` was not on PATH.
REM
REM Runs Anthropic's own official installer, fetched from claude.ai, in a
REM normal PowerShell window you can watch. It does not touch anything else
REM on your machine.

cd /d "%~dp0"
title Installing Claude Code
echo Installing Claude Code from https://claude.ai/install.ps1 ...
echo (Anthropic's own official installer. This may take a minute.)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"

echo.
echo ---------------------------------------------------------------
echo Done (or see any error above).
echo.
echo Close this window, then open a NEW one and run:
echo   launch\1 - First run (setup and live check).cmd
echo again -- a fresh window will pick up "claude" now that it is
echo installed. (It will not show up in this same window.)
echo ---------------------------------------------------------------
echo.
pause
