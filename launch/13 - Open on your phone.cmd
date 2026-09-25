@echo off
REM Serves Odysseus to your phone over the home Wi-Fi. Leave this window open;
REM close it to stop. Nothing leaves the network: the phone talks straight to
REM this PC, and the app on the phone talks straight to the exchanges.
REM
REM The relay (10) is per-machine, so on the phone the Analyst chat and the
REM Bybit line show "relay off"; everything that reads the market works.
cd /d "%~dp0.."
where python >nul 2>&1 || (echo python is not installed - install it from python.org, tick "Add to PATH". & pause & exit /b)

echo.
echo Odysseus on your phone
echo ======================
echo Phone and PC must be on the same Wi-Fi. On the phone, open one of these:
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do echo     http://%%b:8000/
)
echo.
echo (The one starting 192.168 or 10. is usually the right one. Add it to the
echo  phone's home screen and it opens like an app.)
echo.
echo If the phone cannot reach it, Windows Firewall is blocking port 8000 - run
echo "14 - Allow phone through firewall" once, as administrator.
echo.
python -m http.server 8000 --bind 0.0.0.0
