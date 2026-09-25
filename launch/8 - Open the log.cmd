@echo off
cd /d "%~dp0.."
if exist "verdicts\watch.log" (notepad verdicts\watch.log) else (
  if exist "verdicts\first-run.log" (notepad verdicts\first-run.log) else (
    echo No log yet. Run 1, 2 or 3 first. & pause))
