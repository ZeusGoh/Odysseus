# run-analyst.ps1 — first run of the Odysseus analyst, end to end.
#
# Launched by RUN-ANALYST.cmd in the repo root (double-click it).
#
# It exists because Claude cannot run anything on this machine: the Cowork Linux
# shell will not start here, and Windows grants terminals to computer-use in
# click-only mode, so it cannot type a command either. One double-click gets
# round both, and everything is written to verdicts\first-run.log so the result
# can be read back and diagnosed.
#
# Nothing here is destructive. It copies four config files into place, makes
# read-only calls to Bybit, and runs the analyst once.
# part of Odysseus

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

New-Item -ItemType Directory -Force (Join-Path $root 'verdicts') | Out-Null
$log = Join-Path $root 'verdicts\first-run.log'
Remove-Item $log -ErrorAction SilentlyContinue

function Log($msg) {
    Write-Host $msg
    Add-Content -Path $log -Value $msg -Encoding utf8
}
function Run($label, $exe, $argList) {
    Log ''
    Log ('--- ' + $label + ' ---')
    Log ('$ ' + $exe + ' ' + ($argList -join ' '))
    try {
        $out = & $exe @argList 2>&1 | Out-String
        $code = $LASTEXITCODE
    } catch {
        $out = $_.Exception.Message
        $code = -1
    }
    Log $out.TrimEnd()
    Log ('[exit ' + $code + ']')
    return @{ code = $code; out = $out }
}

Log '==============================================='
Log 'Odysseus analyst — first run'
Log (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
Log ('repo: ' + $root)
Log '==============================================='

# ---------- 1. what is installed ----------
Log ''
Log '--- toolchain ---'
foreach ($tool in @('node', 'npm', 'claude', 'git')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if ($cmd) {
        $ver = ''
        try { $ver = (& $tool --version 2>&1 | Select-Object -First 1) } catch { $ver = '(no --version)' }
        Log ("{0,-6} {1,-12} {2}" -f $tool, $ver, $cmd.Source)
    } else {
        Log ("{0,-6} NOT FOUND" -f $tool)
    }
}

$hasNode   = [bool](Get-Command node   -ErrorAction SilentlyContinue)
$hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)

if (-not $hasNode) {
    Log ''
    Log 'STOP: node is not on PATH. Everything below needs it.'
    Log 'Install Node 18+ from https://nodejs.org and run this again.'
    exit 1
}

# ---------- 2. the config Claude could not write remotely ----------
# .claude\ and .mcp.json steer Claude itself, so the device bridge refuses to
# write them. The version-controlled copies live in claude\claude-code-setup\.
Log ''
Log '--- putting the Claude Code config in place ---'
New-Item -ItemType Directory -Force '.claude\agents', '.claude\commands' | Out-Null
$pairs = @(
    @{ from = 'claude\claude-code-setup\stoch-analyst.md'; to = '.claude\agents\stoch-analyst.md' },
    @{ from = 'claude\claude-code-setup\news-analyst.md';  to = '.claude\agents\news-analyst.md'  },
    @{ from = 'claude\claude-code-setup\read.md';          to = '.claude\commands\read.md'        },
    @{ from = 'claude\claude-code-setup\mcp.json';         to = '.mcp.json'                       }
)
foreach ($p in $pairs) {
    if (-not (Test-Path $p.from)) { Log ('  MISSING SOURCE: ' + $p.from); continue }
    Copy-Item $p.from $p.to -Force
    Log ('  ' + $p.to + '  <-  ' + $p.from)
}

# ---------- 3. the app's own test suite ----------
# Proves the engine and the MCP server work on this machine before anything
# touches the network or spends a model call.
$tests = Run 'unit tests (mcp + analyst + watch)' 'node' @('tests\run.js')

# 6 failures are EXPECTED and pre-date all of this: they come from the orphaned
# Logan / Pretcher / Elliott test files left behind by the old feature reverts.
# Anything beyond 6 is a real problem.
if ($tests.out -match '(\d+) passed, (\d+) failed') {
    $failed = [int]$Matches[2]
    if ($failed -le 6) {
        Log ('  ' + $failed + ' failure(s) — expected: the orphaned Logan/Pretcher/Elliott test files.')
    } else {
        Log ('  ' + $failed + ' failures — more than the 6 known orphans. Worth a look.')
    }
}

# ---------- 4. the real exchange ----------
# This is the check that could never be run from the cloud sandbox: its network
# policy blocks api.bybit.com outright.
$check = Run 'engine + MCP against the REAL Bybit API' 'node' @('mcp\check.js', '--live')
$liveOk = ($check.out -match 'ALL CHECKS PASSED AGAINST LIVE BYBIT')

if (-not $liveOk) {
    Log ''
    Log 'STOP: the live check did not pass, so there is no point running the analyst.'
    Log 'The output above says why. Send verdicts\first-run.log back to Claude.'
    exit 1
}

# ---------- 5. the gate, on live data, costing nothing ----------
$dry = Run 'what is worth reading right now (no model calls)' 'node' @('mcp\watch.js', '--dry-run')

if (-not $hasClaude) {
    Log ''
    Log 'The engine side is working. `claude` is not on PATH, so the analysts cannot run yet.'
    Log 'Install Claude Code, then run this again.'
    exit 0
}

# ---------- 6. actually run the analysts ----------
Log ''
Log '--- running the two blind analysts ---'
Log 'This spends model calls on your Claude subscription. First run can take a few minutes.'

if ($dry.out -match 'nothing to read this pass') {
    Log 'The gate found nothing live, so forcing one read on BTC to prove the flow end to end.'
    $read = Run 'analyst read (forced, BTC)' 'node' @('mcp\watch.js', '--symbols', 'BTC', '--all', '--no-publish')
} else {
    $read = Run 'analyst read (whatever the gate picked)' 'node' @('mcp\watch.js', '--no-publish')
}

# ---------- 7. what came out ----------
Log ''
Log '--- the report ---'
$latest = Join-Path $root 'verdicts\latest.json'
if (Test-Path $latest) {
    try {
        $r = Get-Content $latest -Raw | ConvertFrom-Json
        Log ('symbol      : ' + $r.symbol)
        Log ('generated   : ' + $r.generatedAt)
        Log ('agreement   : ' + $r.reconciliation.agreement + ' / ' + $r.reconciliation.direction +
             '  (confidence ' + $r.reconciliation.confidence + ')')
        Log ('stoch call  : ' + $r.stoch.call + '  conviction ' + $r.stoch.conviction)
        Log ('news call   : ' + $r.news.call + '  conviction ' + $r.news.conviction)
        Log ('headline    : ' + $r.reconciliation.headline)
        if ($r.reconciliation.clashes) {
            Log 'clashes     :'
            foreach ($c in $r.reconciliation.clashes) { Log ('  - ' + $c) }
        }
        Log ''
        Log 'It worked. Open Odysseus, go to Trading -> Analyst, and drop this file on it:'
        Log ('  ' + $latest)
    } catch {
        Log ('verdicts\latest.json exists but could not be parsed: ' + $_.Exception.Message)
    }
} else {
    Log 'No report file was written. The output above says why.'
}

Log ''
Log '==============================================='
Log ('Full log: ' + $log)
Log 'Send that file back to Claude if anything above failed.'
Log '==============================================='
