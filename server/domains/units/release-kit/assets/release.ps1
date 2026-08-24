<#
.SYNOPSIS
  release.ps1 — put a release of this repo on ONE stage. Lives in release/; copied here by the
  platform at onboarding. Bash twin: release.sh (same folder).

.DESCRIPTION
  A DUMB, untrusted client. The three inputs are the version (x.y.z), the channel — the maturity
  CEILING of the release: alpha may reach dev only, beta dev and test, stable anywhere — and the
  stage this run puts the release on. The channel is part of the release tag; the stage is not.

  It:
    1. Validates version, channel and stage.
    2. Refuses a dirty worktree.
    3. MINT-ONCE: exactly one release tag per (version, channel). The first run mints
       <x.y.z>-<channel>-<ts14> (ts14 = UTC yyyyMMddHHmmss) on HEAD and pushes the commit + the tag.
       A later run for the SAME version+channel REUSES that tag — that is how a release reaches a
       further stage without being rebuilt: the same commit, the same image, one more stage.
    4. Deletes and re-pushes the deploy ref refs/tags/deploy/<stage>/<tag>. Pushing that ref is the
       ONLY build trigger. It is deleted first because pushing a ref that already stands changes
       nothing and fires no webhook, so a repeat of the same (release, stage) would do nothing at
       all. The deletion fires a webhook too; the platform's trigger drops it.

  The ceiling is checked LOCALLY as a courtesy so a mistake is visible here, but it does NOT stop
  the push: the pipeline is the only thing that can write, and its refusal — naming channel, stage
  and the allowed stages — is the one that counts. Every property here is re-verified there.

.EXAMPLE
  ./release/release.ps1 0.6.0 stable prod
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Version,
  [Parameter(Mandatory = $true, Position = 1)][ValidateSet('stable', 'beta', 'alpha')][string]$Channel,
  [Parameter(Mandatory = $true, Position = 2)][ValidateSet('dev', 'test', 'prod')][string]$Stage
)
$ErrorActionPreference = 'Stop'
function Die($m) { Write-Error "release: $m"; exit 1 }

if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
  Die "version must be x.y.z with no leading zeros (got '$Version')"
}

# The courtesy ceiling check. It WARNS and continues on purpose — see the description.
$admits = @{ alpha = @('dev'); beta = @('dev', 'test'); stable = @('dev', 'test', 'prod') }[$Channel]
if ($admits -notcontains $Stage) {
  Write-Warning "release: channel $Channel admits only: $($admits -join ', '). Stage $Stage is above its ceiling, so the platform will refuse this run. Pushing anyway; the refusal comes from the pipeline."
}

git rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Die 'not inside a git repository' }
if (git status --porcelain) { Die 'worktree is dirty — commit or stash before releasing' }

# Anchor the manifest read at the repo root so it resolves whether the script is run from the
# repo root or from inside release/ (git tag/push are already repo-relative, not cwd-relative).
$root = (git rev-parse --show-toplevel 2>$null)
if (-not $root) { $root = '.' }
$manifest = Join-Path $root 'deploy/platform.yaml'

# Remote view first: mint-once has to see the tags other people pushed, or a second machine would
# mint a second tag for the same version+channel instead of reusing the one that exists.
git fetch --tags --quiet origin 2>$null | Out-Null

$prefix = "$Version-$Channel-"
$existing = @(git tag -l "$prefix*" | Sort-Object)
if ($existing.Count -gt 0) {
  $tag = $existing[-1]
  Write-Host "release: reusing the existing release $tag — one release per version+channel, so putting it on $Stage rebuilds nothing"
}
else {
  $ts14 = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')
  $tag = "$Version-$Channel-$ts14"
  git tag -a $tag -m "release $tag"
  git push origin HEAD
  git push origin "refs/tags/$tag"
  Write-Host "release: minted $tag"
}

# The release COMMIT is the tag's, never HEAD — on a reuse, HEAD has usually moved on.
$sha = (git rev-list -n 1 $tag).Trim()
$sha7 = $sha.Substring(0, 7)

$deployRef = "refs/tags/deploy/$Stage/$tag"
# Delete first (absent on a first deploy — that is the normal case, not an error), then push: the
# push is what the platform's webhook reacts to.
git push origin ":$deployRef" 2>$null | Out-Null
git push origin "${sha}:$deployRef"

$name = '<name>'
if (Test-Path $manifest) {
  $nameLine = Select-String -Path $manifest -Pattern '^name:\s*(.+)$' | Select-Object -First 1
  if ($nameLine) { $name = $nameLine.Matches[0].Groups[1].Value.Trim() }
}

Write-Host "release: $name $tag (commit $sha7) is on its way to $Stage"
Write-Host 'release: the platform builds these image tags, or skips the build when they already exist:'
if (Test-Path $manifest) {
  Select-String -Path $manifest -Pattern '^\s*-\s*name:\s*(.+)$' | ForEach-Object {
    Write-Host "    $($_.Matches[0].Groups[1].Value.Trim()):$tag-$sha7"
  }
}
