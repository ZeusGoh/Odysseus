' watch-hidden.vbs - runs watch.cmd with no window.
'
' Task Scheduler runs an interactive task in your own session, and a console
' window flashing up every half hour is not acceptable. This starts watch.cmd
' hidden (window style 0) and returns at once; watch.cmd itself appends to
' verdicts\watch.log, which is where to look.
' part of Odysseus
Dim sh, here
Set sh = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run "cmd.exe /c """ & here & "watch.cmd""", 0, False
