# register-watch.ps1 - the automatic pass, on Windows Task Scheduler.
#
#   -Minutes 30   how often (default 30)
#   -Remove       take the task away
#   -Wake         also wake the machine from sleep to run (off by default:
#                 a laptop in a bag waking every half hour is not a feature)
#
# Why PowerShell rather than schtasks: schtasks cannot set the two settings
# that matter for a laptop. StartWhenAvailable runs a missed pass as soon as
# the machine is awake again instead of silently skipping to the next slot,
# and MultipleInstances=IgnoreNew stops a scheduled pass from starting on top
# of one you launched from the app. The action runs through watch-hidden.vbs
# so no console window appears.
# part of Odysseus

param(
    [int]$Minutes = 30,
    [switch]$Remove,
    [switch]$Wake
)

$ErrorActionPreference = 'Stop'
$name = 'Odysseus watch'
$root = Split-Path -Parent $PSScriptRoot
$vbs  = Join-Path $root 'mcp\watch-hidden.vbs'

if ($Remove) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($t) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Write-Host "Removed '$name'. Nothing runs by itself now." }
    else    { Write-Host "'$name' was not registered." }
    exit 0
}

if ($Minutes -lt 5) { Write-Host 'Fewer than 5 minutes makes no sense: a board scan alone takes a couple.'; exit 1 }
if (-not (Test-Path $vbs)) { Write-Host "Missing $vbs"; exit 1 }

$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"') -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
             -RepetitionInterval (New-TimeSpan -Minutes $Minutes) `
             -RepetitionDuration ([TimeSpan]::MaxValue)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
             -ExecutionTimeLimit (New-TimeSpan -Minutes 50) `
             -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun:$Wake

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Registered '$name': every $Minutes minutes, hidden, while this PC is awake."
Write-Host '  - a pass missed while asleep runs as soon as the machine wakes'
Write-Host '  - a scheduled pass never starts on top of one already running'
Write-Host ('  - wake from sleep: ' + $(if ($Wake) { 'yes' } else { 'no (pass -Wake to change)' }))
Write-Host 'Everything it does is appended to verdicts\watch.log.'
