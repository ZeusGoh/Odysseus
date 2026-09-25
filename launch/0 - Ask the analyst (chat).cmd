@echo off
REM Opens a Claude Code session in the project, with both analyst servers wired up.
REM This is the one to use when you want to ASK, rather than schedule.
cd /d "%~dp0.."
title Odysseus - ask the analyst

where claude >nul 2>&1
if errorlevel 1 (
  echo Claude Code is not installed, or not on PATH.
  echo Install it, then run this again.
  echo.
  pause
  exit /b
)

if not exist ".mcp.json" (
  echo Setup has not been run yet. Run "1 - First run" first.
  echo.
  pause
  exit /b
)

echo ===============================================================
echo  Ask the analyst
echo ===============================================================
echo.
echo  Try:
echo.
echo     /read SOL
echo         both analysts, blind, reconciled, written to verdicts\
echo.
echo     what do the analysts make of SUI?
echo     run both on my whole watchlist, only tell me where they clash
echo     just the stochastic side on ARB - skip the news
echo     why did SQUEZ move? news analyst only
echo.
echo  /mcp        check both servers are connected
echo  /exit       leave
echo.
echo ===============================================================
echo.
claude
