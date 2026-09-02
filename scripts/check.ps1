#!/usr/bin/env pwsh
# EVERY CHECK THIS REPOSITORY HAS TO PASS, in order, on the machine of the person who changed it.
#
# The PowerShell twin of scripts/check.sh: the same steps, the same order, the same two answers.
# A person working in PowerShell runs this one; the pre-push hook runs the bash one, because a git
# hook is bash on every machine this repository is worked on.
#
# The steps stop at the first red one, and a tool that is not on this machine is named rather than
# skipped — see the bash twin for why both of those are the way they are.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Set-Location (Split-Path -Parent $PSScriptRoot)

function Stop-Red([string] $Step) {
  Write-Output "check: FAIL — $Step"
  exit 1
}

foreach ($tool in @('node', 'npm', 'npx')) {
  if ($null -eq (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Stop-Red "$tool is not on this machine (PATH)"
  }
}

# npm and npx end in a non-zero exit code rather than a PowerShell error, so each step is read from
# $LASTEXITCODE. $ErrorActionPreference does not see a native program's exit code.
Write-Output 'check: 1/2 npm run check'
npm run check
if ($LASTEXITCODE -ne 0) { Stop-Red 'npm run check' }

Write-Output 'check: 2/2 npx vitest run'
npx vitest run
if ($LASTEXITCODE -ne 0) { Stop-Red 'npx vitest run' }

Write-Output 'check: OK — every check green'
