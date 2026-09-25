@echo off
REM Forces a full read on one coin, whether or not anything has happened to it.
cd /d "%~dp0.."
title Odysseus - read one coin
set "SYM="
set /p SYM=Which coin? (e.g. BTC, SOL, SUI):
if "%SYM%"=="" echo No coin given. & pause & exit /b
echo.
echo Reading %SYM% - both analysts, blind. This takes a few minutes.
echo.
node mcp\watch.js --symbols %SYM% --all --no-publish
echo.
pause
