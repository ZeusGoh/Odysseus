' relay-hidden.vbs - keeps the app relay (mcp\panel.js) running, with no window.
'
' Registered by claude\register-relay.ps1 (launch\11) to run at logon. Unlike
' watch-hidden.vbs, this one WAITS: it starts the relay, and if the relay ever
' exits it starts it again after a short pause, so the buttons in Odysseus ->
' Analyst keep working without anyone pressing launch\10. Because it waits,
' Task Scheduler sees the task as running for as long as the relay is, and
' stopping the task stops the relay.
'
' Two ways it stops on its own:
'   - the relay exits with code 3: the port is already held by another relay
'     (a launch\10 window, say). Nothing to keep alive - stand down.
'   - the relay dies within ten seconds five times in a row: something is
'     wrong that restarting will not fix (node missing, a bad edit). Look in
'     verdicts\relay.log.
' part of Odysseus
Option Explicit
Dim sh, here, root, code, started, quick
Set sh = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
root = Left(here, Len(here) - 4)   ' ...\mcp\ -> ...\
quick = 0
Do
  started = Timer
  code = sh.Run("cmd.exe /c cd /d """ & root & """ && node mcp\panel.js >> verdicts\relay.log 2>&1", 0, True)
  If code = 3 Then Exit Do
  If Timer - started >= 0 And Timer - started < 10 Then
    quick = quick + 1
  Else
    quick = 0
  End If
  If quick >= 5 Then Exit Do
  WScript.Sleep 5000
Loop
