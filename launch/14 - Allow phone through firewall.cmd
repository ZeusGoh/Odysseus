@echo off
REM Lets your phone reach Odysseus on port 8000 over the home Wi-Fi (13 serves
REM it). One inbound rule, TCP 8000, private networks only. Do this ONCE.
REM Right-click -> Run as administrator.
net session >nul 2>&1 || (echo Right-click this file and choose "Run as administrator". & pause & exit /b)
netsh advfirewall firewall delete rule name="Odysseus on your phone" >nul 2>&1
netsh advfirewall firewall add rule name="Odysseus on your phone" dir=in action=allow protocol=TCP localport=8000 profile=private
echo.
echo Done. Run "13 - Open on your phone" and open the address it shows on the phone.
pause
