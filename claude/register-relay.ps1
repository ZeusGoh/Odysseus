# register-relay.ps1 - the app relay, always on, via Windows Task Scheduler.
#
#   (no flags)   register: starts the relay now, and again at every logon
#   -Remove      take the task away and stop the relay it is running
#
# The relay (mcp\panel.js) is what the buttons in Odysseus -> Analyst talk to.
# Until now it only ran while a launch\10 window was open. This registers a
# task that runs mcp\relay-hidden.vbs at logon: no window, and the relay is
# restarted if it ever exits. Same reasons as register-watch.ps1 for using
# PowerShell over schtasks - and the task must not have the default one-hour
# execution limit, or Task Scheduler would kill the relay every hour.
# part of Odysseus

param(
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$name = 'Odysseus relay'
$root = Split-Path -Parent $PSScriptRoot
$vbs  = Join-Path $root 'mcp\relay-hidden.vbs'

# the relay processes this machine is running, by command line
function Get-RelayProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'panel\.js' }
}

if ($Remove) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($t) {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "Removed '$name'."
    } else { Write-Host "'$name' was not registered." }
    $procs = @(Get-RelayProcesses)
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($procs.Count) { Write-Host "Stopped $($procs.Count) running relay process(es)." }
    Write-Host 'The relay now runs only while a launch\10 window is open.'
    exit 0
}

if (-not (Test-Path $vbs)) { Write-Host "Missing $vbs"; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'node is not installed, or not on PATH.'; exit 1 }

$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"') -WorkingDirectory $root
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
             -ExecutionTimeLimit ([TimeSpan]::Zero) `
             -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

# a launch\10 window already holding the port would make the task's relay exit
# at once (code 3) and stand down - so start the task only if nothing is running
if (@(Get-RelayProcesses).Count) {
    Write-Host "Registered '$name'. A relay is already running (a launch\10 window?) - leaving it; the task takes over from the next logon."
} else {
    Start-ScheduledTask -TaskName $name
    Write-Host "Registered '$name' and started it: the relay is on now, and again at every logon, with no window."
}
Write-Host '  - if it ever exits it is restarted after 5 seconds'
Write-Host '  - launch\10 is no longer needed; pressing it while this runs just says the port is taken'
Write-Host '  - its output goes to verdicts\relay.log'
Write-Host '  - launch\12 (or this script with -Remove) turns it off again'
