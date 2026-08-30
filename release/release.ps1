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
    5. Waits for the release-images run of that tag, because a tag is a name and not a release
       until the images exist.
    6. Writes the image pin into the platform tree the manifest names, on the trunk and on every
       install branch whose own cluster map says role: master.

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

# THE PIN GRAMMAR AND NOTHING ELSE: builds[]{name,image,tag}, in the values file of the stage this
# release is going to. Read and written by name rather than by line, so a file whose entries are
# ordered differently is still pinned and a file that carries none is left alone. Answers the
# tree-relative paths whose tag actually moved.
function Write-StagePin {
  param(
    [Parameter(Mandatory = $true)][string]$Tree,
    [Parameter(Mandatory = $true)][string]$PinStage,
    [Parameter(Mandatory = $true)][string]$ImageTag,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$BuildNames
  )
  $inventories = Join-Path $Tree 'clusters/inventories'
  if (-not (Test-Path -LiteralPath $inventories)) { return @() }
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  $touched = @()
  foreach ($inventory in Get-ChildItem -LiteralPath $inventories -Directory) {
    $path = Join-Path $inventory.FullName "values-$PinStage.yaml"
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $out = [System.Collections.Generic.List[string]]::new()
    $image = $null
    $changed = $false
    foreach ($line in [System.IO.File]::ReadAllText($path).Split([char]10)) {
      $imageLine = [regex]::Match($line, '^(\s*)image:\s*(\S+)\s*$')
      if ($imageLine.Success) { $image = $imageLine.Groups[2].Value }
      $tagLine = [regex]::Match($line, '^(\s*)tag:\s*\S+\s*$')
      if ($tagLine.Success -and $BuildNames -contains $image) {
        $line = '{0}tag: "{1}"' -f $tagLine.Groups[1].Value, $ImageTag
        $image = $null
        $changed = $true
      }
      $out.Add($line)
    }
    # WRITTEN ONLY WHERE A TAG MOVED. A file compared by its whole text is a file rewritten for a
    # trailing newline, and a commit that names files it did not change is one nobody can read.
    if ($changed) {
      [System.IO.File]::WriteAllText($path, ($out -join "`n"), $utf8NoBom)
      $touched += ([System.IO.Path]::GetRelativePath($Tree, $path) -replace '\\', '/')
    }
  }
  return $touched
}

# One branch of the platform tree, pinned and pushed. The checkout and the reset onto the remote
# branch are what make the write land on THAT branch and not on whatever the clone had open.
function Publish-BranchPin {
  param([Parameter(Mandatory = $true)][string]$Branch)
  git -C $platformRepoDir checkout --quiet $Branch 2>$null
  if ($LASTEXITCODE -ne 0) { Die "the platform tree has no branch $Branch — nothing further was pinned" }
  git -C $platformRepoDir reset --quiet --hard "origin/$Branch"
  $pinned = @(Write-StagePin -Tree $platformRepoDir -PinStage $Stage -ImageTag "$tag-$sha7" -BuildNames $buildNames)
  if ($pinned.Count -eq 0) {
    Write-Host "release: $Branch carries no values-$Stage.yaml pin of $name — left as it stands"
    return
  }
  git -C $platformRepoDir add -- @pinned
  git -C $platformRepoDir commit --quiet -m "Pin $Stage to $tag" -m "Written by the release of $name, once its images were built."
  git -C $platformRepoDir push --quiet origin $Branch
  if ($LASTEXITCODE -ne 0) { Die "the pin of $Stage to $tag-$sha7 could not be pushed to $Branch of $platformRepo" }
  Write-Host "release: pinned $Branch to $tag-$sha7 in $($pinned -join ' ')"
  $script:pinnedAny = $true
}

# THE COMMIT A TAG SITS ON DECLARES THE VERSION THE TAG NAMES. The build reads the version out of
# the tag, so a package.json still declaring an older number labels the artifact with a version
# nobody released. The write happens BEFORE the tag is created: a tag placed first would point at
# the commit that still carries the old number, and a release does not move a tag afterwards.
# Only the FIRST "version" line is touched. That is the manifest's own; a version further down
# belongs to a dependency and is not this release's to move.
function Set-ManifestVersion($Root, $Version, $Tag) {
  $file = Join-Path $Root 'package.json'
  $text = [System.IO.File]::ReadAllText($file)
  $rx = [regex]'(?m)^(\s*)"version":\s*"[^"]*"'
  if (-not $rx.IsMatch($text)) { Die "package.json declares no version, so this release has nothing to stamp" }
  $bumped = $rx.Replace($text, '$1"version": "' + $Version + '"', 1)
  if ($bumped -eq $text) { return }
  [System.IO.File]::WriteAllText($file, $bumped)
  git add -- $file
  git commit --quiet -m "release: $Tag"
  if ($LASTEXITCODE -ne 0) { Die "the version bump to $Version could not be committed" }
  Write-Host "release: package.json declares $Version"
}

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
  Set-ManifestVersion $root $Version $tag
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

# ── The build, waited for, and the pin it makes true ──────────────────────────────────────────
#
# THE TAG IS A NAME AND NOT A RELEASE UNTIL THE IMAGES EXIST. Pushing it starts the workflow that
# builds them (.github/workflows/release-images.yml); until that is green there is nothing to pin a
# cluster to, and a pin written earlier names an image a kubelet answers with ImagePullBackOff.
# So this waits, and only then writes.
#
# WHY THE WRITE IS HERE AND NOT IN THE WORKFLOW. The pin lives in ANOTHER repository, and a
# workflow's own token reaches only the one it runs in — a cross-repository write needs a credential
# somebody has to make, hold and replace. This script runs on a machine that is already logged in to
# both. The credential problem does not exist here, so neither does the credential.
#
# THE MANIFEST NAMES THE TREE, so no person has to remember one. `platformRepo` in the manifest
# beside this script says which repository carries this unit's pins; a consumer's copy names its own
# there and can reach no other. A manifest that names none stops the release rather than guessing a
# path, which would be the same mistake as guessing a credential.
#
# THE TREE IS CLONED FRESH for the write. Nothing here depends on where a checkout happens to sit on
# the machine, and nothing here can touch one: a release has no business changing a repository
# somebody else is working in.
#
# EVERY PATH THAT DOES NOT PIN ENDS THE RUN. A release that says it is on its way to a stage while
# the tree that stage reads still names the previous images is telling the operator something that
# is not so, and the machine is where they find out.
$name = ''
$platformRepo = ''
$buildNames = @()
if (Test-Path -LiteralPath $manifest) {
  $manifestText = [System.IO.File]::ReadAllText($manifest)
  $nameLine = [regex]::Match($manifestText, '(?m)^name:[ \t]*(.+)$')
  if ($nameLine.Success) { $name = $nameLine.Groups[1].Value.Trim() }
  $repoLine = [regex]::Match($manifestText, '(?m)^platformRepo:[ \t]*(.+)$')
  if ($repoLine.Success) { $platformRepo = ($repoLine.Groups[1].Value -replace '\s*#.*$', '').Trim() }
  $buildNames = @([regex]::Matches($manifestText, '(?m)^\s*-\s*name:\s*(\S+)') | ForEach-Object { $_.Groups[1].Value })
}
if (-not $name) { Die "the manifest $manifest states no name — it is what the pin and the release line are written under" }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Die "gh is not on this path, so the build cannot be waited for and nothing can be pinned — the tag is pushed and the images may still build, but this release is not on any stage"
}
Write-Host "release: waiting for the images of $tag — the pin is written when they exist"
$runId = ''
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  $runId = (gh run list --workflow release-images --branch $tag --limit 1 --json databaseId --jq '.[0].databaseId' 2>$null | Select-Object -First 1)
  if ($runId) { $runId = "$runId".Trim() }
  if ($runId) { break }
  Start-Sleep -Seconds 4
}
if (-not $runId) {
  Die "no release-images run appeared for $tag within two minutes — the images are unbuilt and nothing was pinned"
}
gh run watch $runId --exit-status --interval 20 *> $null
if ($LASTEXITCODE -ne 0) {
  # Written straight to stderr: Write-Error under ErrorActionPreference Stop ends the script where
  # it stands, so the exit code below would never be reached and the run would report 1, not 75.
  [Console]::Error.WriteLine("release: the images of $tag did not build — no pin was written. Read the run: gh run view $runId --log-failed")
  exit 75
}
Write-Host "release: the images of $tag are built"
if (-not $platformRepo) {
  Die "the manifest $manifest states no platformRepo, so there is no tree to pin this release into — add the repository that carries this unit's values-<stage>.yaml files"
}

$platformRepoDir = (New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName()))).FullName
try {
  git clone --quiet "https://github.com/$platformRepo.git" $platformRepoDir
  if ($LASTEXITCODE -ne 0) { Die "the platform tree $platformRepo could not be cloned — nothing was pinned" }

  # EVERY BRANCH A CLUSTER ACTUALLY READS, and the trunk they are cut from.
  #
  # A cluster's ArgoCD tracks its own INSTALL BRANCH — the root application's targetRevision is the
  # cluster's domain, not the default branch and not a tag — so a pin written only on the trunk is a
  # pin no machine ever sees. It is written on the trunk as well, because an install branch that is
  # regenerated later takes what stands there.
  #
  # WHICH INSTALL BRANCHES: the ones whose own cluster map says `role: master`. A branch states its
  # role in clusters/active/<branch>.yaml, which is read here without checking the branch out. A
  # cluster holding the slave part runs no copy of this unit, so pinning its branch would move a
  # value nothing reads.
  $pinnedAny = $false
  Publish-BranchPin -Branch 'master'
  foreach ($ref in (git -C $platformRepoDir for-each-ref --format='%(refname:strip=3)' refs/remotes/origin)) {
    if ($ref -eq 'master' -or $ref -eq 'HEAD') { continue }
    $map = (git -C $platformRepoDir show "origin/${ref}:clusters/active/$ref.yaml" 2>$null)
    $roleLine = [regex]::Match(($map -join "`n"), '(?m)^role:[ \t]*(.*)$')
    if (-not $roleLine.Success -or $roleLine.Groups[1].Value.Trim() -ne 'master') { continue }
    Publish-BranchPin -Branch $ref
  }
  if (-not $pinnedAny) {
    Die "no branch of $platformRepo carries a values-$Stage.yaml pin of $name — the images are built and no cluster reads them, so this release reaches nothing"
  }
}
finally {
  Remove-Item -Recurse -Force -LiteralPath $platformRepoDir -ErrorAction SilentlyContinue
}

Write-Host "release: $name $tag (commit $sha7) is on its way to $Stage"
Write-Host 'release: the platform builds these image tags, or skips the build when they already exist:'
foreach ($build in $buildNames) {
  Write-Host "    ${build}:$tag-$sha7"
}
