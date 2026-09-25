# setup-cloud-credentials.ps1 — one-time, so reports can publish themselves.
#
# Launched by launch\9 - Set up auto-publish to app.cmd (double-click that).
#
# watch.js already tries to publish every report it writes — it just has
# nowhere to read your Cloud login from, because nobody is there to type a
# password into an hourly scheduled task at 3am. This writes it once, to a
# file outside the repo, so every future run can read it instead of asking.
#
# Your password is typed here, in this window, by you. It is written straight
# to that one file and nowhere else — this script does not send it anywhere,
# and it is never echoed back to the screen.
# part of Odysseus

$ErrorActionPreference = 'Stop'
$path = Join-Path $env:USERPROFILE '.odysseus-cloud.json'

Write-Host 'Odysseus - set up automatic publishing'
Write-Host '======================================='
Write-Host ''
Write-Host 'This is the Cloud account your Odysseus app itself signs into (the same'
Write-Host 'one the app''s Cloud panel already uses to sync your data).'
Write-Host ''

if (Test-Path $path) {
    Write-Host "A credentials file already exists at:"
    Write-Host "  $path"
    $overwrite = Read-Host 'Replace it? (y/N)'
    if ($overwrite -notmatch '^[Yy]') { Write-Host 'Left unchanged.'; exit 0 }
}

$email = Read-Host 'Cloud account email'
if (-not $email) { Write-Host 'No email entered - nothing saved.'; exit 1 }

$securePw = Read-Host 'Cloud account password' -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePw)
try {
    $password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if (-not $password) { Write-Host 'No password entered - nothing saved.'; exit 1 }

$obj = [ordered]@{ email = $email; password = $password }
$obj | ConvertTo-Json | Set-Content -Path $path -Encoding utf8

# best effort: keep it readable only by this account, same as any credential file
try { icacls $path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null } catch { }

Write-Host ''
Write-Host "Saved to $path."
Write-Host 'From now on, every hourly watch run - and any manual read you do not'
Write-Host 'force with --no-publish - will push its report straight into the app.'
Write-Host ''
Write-Host 'To try it right now on the report already sitting in verdicts\latest.json:'
Write-Host '  node mcp\publish.js verdicts\latest.json'
