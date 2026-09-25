@echo off
REM ADD-CLAUDE-TO-PATH.cmd -- double-click this once, after installing Claude Code.
REM
REM Claude Code installs to C:\Users\<you>\.local\bin but its own installer does
REM not add that folder to PATH automatically. This script adds it -- and only
REM it -- to your USER PATH (not the system PATH, no admin needed). Safe to run
REM more than once: it checks first and does nothing if it's already there.

title Adding Claude Code to PATH
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$newDir = Join-Path $env:USERPROFILE '.local\bin';" ^
  "$userPath = [Environment]::GetEnvironmentVariable('PATH','User');" ^
  "$parts = @(); if ($userPath) { $parts = $userPath -split ';' };" ^
  "if ($parts -contains $newDir) {" ^
  "  Write-Host \"Already on PATH: $newDir\"" ^
  "} else {" ^
  "  $updated = if ([string]::IsNullOrEmpty($userPath)) { $newDir } else { \"$userPath;$newDir\" };" ^
  "  [Environment]::SetEnvironmentVariable('PATH', $updated, 'User');" ^
  "  Write-Host \"Added to your PATH: $newDir\"" ^
  "}"

echo.
echo ---------------------------------------------------------------
echo Done. Close this window, then open a NEW one and run:
echo   launch\1 - First run (setup and live check).cmd
echo A fresh window is required to pick up the PATH change.
echo ---------------------------------------------------------------
echo.
pause
