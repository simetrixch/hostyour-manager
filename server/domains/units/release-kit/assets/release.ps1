<#
.SYNOPSIS
  release.ps1 - put a release of this repo on ONE stage. Lives in release/; copied here by the
  platform at onboarding. Bash twin: release.sh (same folder). The two are held to answering
  identically.

.DESCRIPTION
  The three inputs are the version (x.y.z), the channel - the maturity CEILING of the release: alpha
  may reach dev only, beta dev and test, stable anywhere - and the stage this run puts the release
  on. The channel is part of the release tag; the stage is not.

  It:
    1. Validates version, channel and stage.
    2. Refuses a dirty worktree.
    3. Reads deploy/platform.yaml: the unit name, the optional platformRepo, and the build names.
    4. PIN PRE-FLIGHT, only where platformRepo is declared: proves this machine can write that tree
       BEFORE anything is minted.
    5. MINT-ONCE: exactly one release tag per (version, channel). The first run stamps the version
       into package.json where the repo has one, mints <x.y.z>-<channel>-<ts14> (ts14 = UTC
       yyyyMMddHHmmss) on HEAD and pushes the commit + the tag. A later run for the SAME
       version+channel REUSES that tag - that is how a release reaches a further stage without being
       rebuilt: the same commit, the same image, one more stage.
    6. Deletes and re-pushes the deploy ref refs/tags/deploy/<stage>/<tag>. Pushing that ref is the
       ONLY build trigger. It is deleted first because pushing a ref that already stands changes
       nothing and fires no webhook, so a repeat of the same (release, stage) would do nothing at
       all. The deletion fires a webhook too; the platform's trigger drops it.
    7. Where platformRepo is declared: waits for the release-images run of that tag, because a tag is
       a name and not a release until the images exist, and then writes the image pin into that tree,
       on the trunk and on every install branch whose cluster RUNS this unit.

  THE TWO SHAPES THIS ONE SCRIPT SERVES, and what tells them apart. A unit whose manifest declares NO
  platformRepo is built and pinned by the platform's build plane, which the deploy ref above reaches.
  Steps 4 and 7 never run for it: no gh, no network beyond its own origin. A unit whose manifest DOES
  declare platformRepo builds its own images in its own repository and its pins live in a tree only a
  machine is logged in to for writing, so this script waits and writes them itself. The manifest
  names that tree, so no person has to remember one, and a copy of this script in another repository
  names its own there and can reach no other.

  The ceiling is checked LOCALLY as a courtesy so a mistake is visible here, but it does NOT stop
  the push: the pipeline is the only thing that can write, and its refusal - naming channel, stage
  and the allowed stages - is the one that counts. Every property here is re-verified there.

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
# WHAT THIS SCRIPT PRINTS, AND WHO WRITES THE NEWLINE. Every printed line is ASCII and ends with the
# one "`n" written here, because neither is the host's to choose. Write-Host and WriteLine end a line
# with the HOST's ending, which on Windows is two bytes where the bash twin writes one; and
# [Console]::Error.WriteLine writes in the console's CODE PAGE, which turned a printed em dash into a
# different byte. Both made the twins answer differently for reasons that have nothing to do with the
# release, and the two are held to being byte-for-byte the same. Comments carry whatever characters
# they like; only what is PRINTED is bound.
#
# Written straight to the console streams and not through Write-Error, so a refusal reads as the one
# sentence the bash twin prints rather than as a wrapped error record with a caret diagram over it —
# and so the exit code is the one chosen here. Under ErrorActionPreference Stop, Write-Error ends the
# script where it stands, which would make every `exit` after it unreachable.
function Write-Line($m) { [Console]::Out.Write("$m`n") }
function Say($m) { Write-Line "release: $m" }
function Warn($m) { [Console]::Error.Write("release: $m`n") }
function Note($m) { [Console]::Error.Write("$m`n") }
function Die($m) { Warn $m; exit 1 }

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

# Does this unit run on a cluster whose role is $Role? A role names every PART the cluster carries,
# master+slave included, while the unit's runsOn names the ONE part it belongs to — so the match is
# against the parts, exactly as the platform-apps ApplicationSet's In selector matches them, and
# every-cluster belongs on all of them.
function Test-RunsHere {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Role)
  if ($runsOn -eq 'every-cluster') { return $true }
  return ($Role -split '\+') -contains $runsOn
}

# One branch of the platform tree, pinned and pushed. The checkout and the reset onto the remote
# branch are what make the write land on THAT branch and not on whatever the clone had open.
function Publish-BranchPin {
  param([Parameter(Mandatory = $true)][string]$Branch)
  git -C $platformRepoDir checkout --quiet $Branch 2>$null
  if ($LASTEXITCODE -ne 0) { Die "the platform tree has no branch $Branch - nothing further was pinned" }
  git -C $platformRepoDir reset --quiet --hard "origin/$Branch"
  $pinned = @(Write-StagePin -Tree $platformRepoDir -PinStage $Stage -ImageTag "$tag-$sha7" -BuildNames $buildNames)
  if ($pinned.Count -eq 0) {
    Say "$Branch carries no values-$Stage.yaml pin of $name - left as it stands"
    return
  }
  git -C $platformRepoDir add -- @pinned
  git -C $platformRepoDir commit --quiet -m "Pin $Stage to $tag" -m "Written by the release of $name, once its images were built."
  git -C $platformRepoDir push --quiet origin $Branch
  if ($LASTEXITCODE -ne 0) { Die "the pin of $Stage to $tag-$sha7 could not be pushed to $Branch of $platformRepo" }
  Say "pinned $Branch to $tag-$sha7 in $($pinned -join ' ')"
  $script:pinnedAny = $true
}

# THE COMMIT A TAG SITS ON DECLARES THE VERSION THE TAG NAMES. The build reads the version out of
# the tag, so a package.json still declaring an older number labels the artifact with a version
# nobody released. The write happens BEFORE the tag is created: a tag placed first would point at
# the commit that still carries the old number, and a release does not move a tag afterwards.
# Only the FIRST "version" line is touched. That is the manifest's own; a version further down
# belongs to a dependency and is not this release's to move.
# A repository with no package.json, or one that declares no version, has nothing that could go
# stale — that is said out loud and the release continues, because a unit written in another
# language is the ordinary case for this script and not a broken one.
function Set-ManifestVersion($Root, $Version, $Tag) {
  $file = Join-Path $Root 'package.json'
  if (-not (Test-Path -LiteralPath $file)) {
    Say 'this repository carries no package.json - no version manifest to stamp'
    return
  }
  $text = [System.IO.File]::ReadAllText($file)
  $rx = [regex]'(?m)^(\s*)"version":\s*"[^"]*"'
  if (-not $rx.IsMatch($text)) {
    Say 'package.json declares no version - nothing to stamp'
    return
  }
  $bumped = $rx.Replace($text, '$1"version": "' + $Version + '"', 1)
  if ($bumped -eq $text) { return }
  [System.IO.File]::WriteAllText($file, $bumped)
  git add -- $file
  git commit --quiet -m "release: $Tag"
  if ($LASTEXITCODE -ne 0) { Die "the version bump to $Version could not be committed" }
  Say "package.json declares $Version"
}

if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
  Die "version must be x.y.z with no leading zeros (got '$Version')"
}

# The courtesy ceiling check. It WARNS and continues on purpose — see the description.
$admits = @{ alpha = @('dev'); beta = @('dev', 'test'); stable = @('dev', 'test', 'prod') }[$Channel]
if ($admits -notcontains $Stage) {
  Warn "WARNING - channel $Channel admits only: $($admits -join ' '). Stage $Stage is above its ceiling, so the platform will refuse this run. Pushing anyway; the refusal comes from the pipeline."
}

git rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Die 'not inside a git repository' }
if (git status --porcelain) { Die 'worktree is dirty - commit or stash before releasing' }

# Anchor the manifest read at the repo root so it resolves whether the script is run from the
# repo root or from inside release/ (git tag/push are already repo-relative, not cwd-relative).
$root = (git rev-parse --show-toplevel 2>$null)
if (-not $root) { $root = '.' }
$manifest = "$root/deploy/platform.yaml"

$name = ''
$platformRepo = ''
$buildNames = @()
if (Test-Path -LiteralPath $manifest) {
  $manifestText = [System.IO.File]::ReadAllText($manifest)
  $nameLine = [regex]::Match($manifestText, '(?m)^name:[ \t]*(\S+)')
  if ($nameLine.Success) { $name = $nameLine.Groups[1].Value }
  $repoLine = [regex]::Match($manifestText, '(?m)^platformRepo:[ \t]*(\S+)')
  if ($repoLine.Success) { $platformRepo = $repoLine.Groups[1].Value }
  $buildNames = @([regex]::Matches($manifestText, '(?m)^\s*-\s*name:\s*(\S+)') | ForEach-Object { $_.Groups[1].Value })
}
if (-not $name) { Die "the manifest $manifest states no name - it is what the release line and any pin are written under" }

# ── The pin pre-flight ────────────────────────────────────────────────────────────────────────
#
# A RELEASE THAT CANNOT WRITE ITS PIN IS REFUSED BEFORE IT MINTS ANYTHING. Everything below this
# point mutates something somebody else reads: a version commit on the default branch, a release
# tag, and a deploy ref whose push is what starts the build. Discovering only afterwards that the
# platform tree is unreachable leaves a release that exists, was built, and reaches no stage — and
# the tag cannot be minted a second time, so the repair is by hand.
#
# THE PUSH IS PROBED, NOT THE CLONE. The platform tree may be public, so a clone proves nothing
# about write access; `git push --dry-run` performs the same reference discovery a real push does
# against the remote's receive side, which is refused without write access either way. It sends no
# update. GIT_TERMINAL_PROMPT=0 turns a machine holding no credential into a refusal instead of a
# process waiting on a prompt nobody is watching.
#
# THE TREE IS CLONED FRESH and reused for the write below. Nothing here depends on where a checkout
# happens to sit on the machine, and nothing here can touch one. Everything from here to the end of
# the script stands inside one try/finally — this spelling of the bash twin's EXIT trap, because
# PowerShell runs a finally for `exit` and for a terminating error alike — so the clone is removed
# on every path out, the refusals included.
$platformRepoDir = ''
$runsOn = ''
try {
  if ($platformRepo) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
      Die "gh is not on this path, so the build of this release could not be waited for and its pin could not be written - nothing has been minted or pushed"
    }
    $platformRepoDir = (New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName()))).FullName
    git clone --quiet "https://github.com/$platformRepo.git" $platformRepoDir
    if ($LASTEXITCODE -ne 0) { Die "the platform tree $platformRepo could not be cloned, so this release could not write its pin - nothing has been minted or pushed" }
    $priorPrompt = $env:GIT_TERMINAL_PROMPT
    $env:GIT_TERMINAL_PROMPT = '0'
    try { git -C $platformRepoDir push --dry-run --quiet origin HEAD *> $null }
    finally {
      if ($null -eq $priorPrompt) { Remove-Item Env:GIT_TERMINAL_PROMPT } else { $env:GIT_TERMINAL_PROMPT = $priorPrompt }
    }
    if ($LASTEXITCODE -ne 0) {
      Die "this machine may not push to $platformRepo, so this release could not write its pin - nothing has been minted or pushed. A unit that pins itself is released from a machine logged in to both repositories, never from a build runner."
    }
    # WHERE THE UNIT RUNS, which is what decides which branches its pin belongs on. The platform
    # states it per unit, in one place: runsOn in clusters/inventories/<unit>/app.yaml on the trunk,
    # the very field the platform-apps ApplicationSet selects a cluster's workloads by. Read here, in
    # the pre-flight, so a unit whose inventory does not say where it runs is refused before anything
    # is minted rather than after its images are built.
    $appYaml = "clusters/inventories/$name/app.yaml"
    $runsOnLine = [regex]::Match(((git -C $platformRepoDir show "origin/master:$appYaml" 2>$null) -join "`n"), '(?m)^runsOn:[ \t]*(\S+)')
    if ($runsOnLine.Success) { $runsOn = $runsOnLine.Groups[1].Value }
    if (-not $runsOn) {
      Die "$appYaml on the trunk of $platformRepo states no runsOn, so where $name runs is unknown and its pin belongs to no branch in particular - nothing has been minted or pushed"
    }
  }

  # Remote view first: mint-once has to see the tags other people pushed, or a second machine would
  # mint a second tag for the same version+channel instead of reusing the one that exists.
  git fetch --tags --quiet origin 2>$null | Out-Null

  $prefix = "$Version-$Channel-"
  $existing = @(git tag -l "$prefix*" | Sort-Object)

  # A TAG THAT NEVER REACHED ORIGIN AND NAMES ANOTHER COMMIT IS RESIDUE, and reusing it aims every
  # retry at the commit a refused push left behind. The tag is minted before it is pushed, so a push
  # the pre-push hook refuses leaves it standing here and nowhere else; the next run finds it, reuses
  # it, and is refused again — for the same reason, printed as if it were about the new attempt.
  #
  # A TAG THAT IS ON ORIGIN IS LEFT EXACTLY AS IT STANDS, whatever commit it names. That is mint-once
  # itself, and the reuse below relies on it: one release per version+channel, put on a further stage
  # without rebuilding, which is why the release commit is read off the tag and never off HEAD.
  if ($existing.Count -gt 0) {
    $candidate = $existing[-1]
    git ls-remote --exit-code --tags origin "refs/tags/$candidate" *> $null
    $onOrigin = ($LASTEXITCODE -eq 0)
    $candidateSha = (git rev-parse --verify --quiet "$candidate^{commit}" | Select-Object -First 1)
    $headSha = (git rev-parse --verify HEAD | Select-Object -First 1)
    if (-not $onOrigin -and "$candidateSha" -ne "$headSha") {
      $candidateShort = (git rev-parse --short=7 "$candidate^{commit}" | Select-Object -First 1)
      Say "$candidate stands on this machine only and names $candidateShort, not the commit being released. A run whose push was refused left it behind; it is dropped and cut again."
      git tag -d $candidate *> $null
      if ($LASTEXITCODE -ne 0) {
        Die "the leftover tag $candidate could not be dropped, and reusing it would release a commit nobody is releasing"
      }
      $existing = @()
    }
  }

  if ($existing.Count -gt 0) {
    $tag = $existing[-1]
    Say "reusing the existing release $tag - one release per version+channel, so putting it on $Stage rebuilds nothing"
  }
  else {
    $ts14 = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')
    $tag = "$Version-$Channel-$ts14"
    Set-ManifestVersion $root $Version $tag
    git tag -a $tag -m "release $tag"
    git push origin HEAD
    git push origin "refs/tags/$tag"
    Say "minted $tag"
  }

  # The release COMMIT is the tag's, never HEAD — on a reuse, HEAD has usually moved on.
  $sha = (git rev-list -n 1 $tag).Trim()
  $sha7 = $sha.Substring(0, 7)

  $deployRef = "refs/tags/deploy/$Stage/$tag"
  # Delete first (absent on a first deploy — that is the normal case, not an error), then push: the
  # push is what the platform's webhook reacts to.
  git push origin ":$deployRef" 2>$null | Out-Null
  git push origin "${sha}:$deployRef"

  # ── The build, waited for, and the pin it makes true ────────────────────────────────────────
  #
  # THE TAG IS A NAME AND NOT A RELEASE UNTIL THE IMAGES EXIST. Pushing it starts the workflow that
  # builds them (.github/workflows/release-images.yml); until that is green there is nothing to pin
  # a cluster to, and a pin written earlier names an image a kubelet answers with ImagePullBackOff.
  # So this waits, and only then writes.
  #
  # WHY THE WRITE IS HERE AND NOT IN THE WORKFLOW. The pin lives in ANOTHER repository, and a
  # workflow's own token reaches only the one it runs in — a cross-repository write needs a
  # credential somebody has to make, hold and replace. This script runs on a machine that is already
  # logged in to both. The credential problem does not exist here, so neither does the credential.
  #
  # EVERY PATH THAT DOES NOT PIN ENDS THE RUN. A release that says it is on its way to a stage while
  # the tree that stage reads still names the previous images is telling the operator something that
  # is not so, and the machine is where they find out.
  if (-not $platformRepo) {
    Say "the manifest $manifest names no platformRepo, so nothing is pinned from here - the deploy ref above is what the platform reacts to"
  }
  else {
    Say "waiting for the images of $tag - the pin is written when they exist"
    $runId = ''
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      $runId = (gh run list --workflow release-images --branch $tag --limit 1 --json databaseId --jq '.[0].databaseId' 2>$null | Select-Object -First 1)
      if ($runId) { $runId = "$runId".Trim() }
      if ($runId) { break }
      Start-Sleep -Seconds 4
    }
    if (-not $runId) {
      Die "no release-images run appeared for $tag within two minutes - the images are unbuilt and nothing was pinned"
    }
    gh run watch $runId --exit-status --interval 20 *> $null
    if ($LASTEXITCODE -ne 0) {
      # 75 and not Die's 1: a build that ran and failed is a different answer from a release that
      # was refused, and the bash twin says so with the same number.
      # THE REASON IS PRINTED HERE, not left to a command somebody is told to run next. Whoever
      # reads this failure is standing at a terminal with the credential already in hand, and a
      # release that sends them one round trip away for the cause has answered nothing. The FAILED
      # STEPS and not the whole log: a green build is thousands of lines and they bury the rest.
      Note "----- the failed steps of run $runId -----"
      $log = (gh run view $runId --log-failed 2>&1 | Select-Object -Last 120)
      if ($log) { $log | ForEach-Object { Note $_ } }
      else { Note "the log of run $runId could not be read" }
      Note "----- end of run $runId -----"
      Warn "the images of $tag did not build - no pin was written"
      exit 75
    }
    Say "the images of $tag are built"
    # The clone is as old as the pre-flight, which stands before a build that takes minutes. Refresh
    # the remote-tracking refs, or the reset below writes onto a tip somebody else has moved past and
    # the push is refused for a reason that has nothing to do with this release.
    git -C $platformRepoDir fetch --quiet --prune origin
    if ($LASTEXITCODE -ne 0) { Die "the platform tree $platformRepo could not be refreshed after the build - the images exist and nothing was pinned" }

    # EVERY BRANCH A CLUSTER ACTUALLY READS, and the trunk they are cut from.
    #
    # A cluster's ArgoCD tracks its own INSTALL BRANCH — the root application's targetRevision is
    # the cluster's domain, not the default branch and not a tag — so a pin written only on the
    # trunk is a pin no machine ever sees. It is written on the trunk as well, because an install
    # branch that is regenerated later takes what stands there.
    #
    # WHICH INSTALL BRANCHES: the ones whose cluster RUNS this unit. A branch states its role in
    # clusters/active/<branch>.yaml, which is read here without checking the branch out, and the unit
    # states its runsOn in its inventory — the same two facts the platform-apps ApplicationSet
    # matches to decide which workloads a cluster renders. A cluster that runs no copy of this unit
    # is passed over, because a pin on its branch moves a value nothing there reads.
    #
    # ASKING WHETHER THE BRANCH IS A MASTER instead is a different question with the same answer
    # today, and a wrong answer on the first unit that declares runsOn: slave or every-cluster and
    # carries a build: its pin would reach no slave branch at all, and the release would report
    # itself on its way to the stage while the machines that run it kept the previous image.
    $pinnedAny = $false
    Publish-BranchPin -Branch 'master'
    foreach ($ref in (git -C $platformRepoDir for-each-ref --format='%(refname:strip=3)' refs/remotes/origin)) {
      if ($ref -eq 'master' -or $ref -eq 'HEAD') { continue }
      $map = (git -C $platformRepoDir show "origin/${ref}:clusters/active/$ref.yaml" 2>$null)
      $roleLine = [regex]::Match(($map -join "`n"), '(?m)^role:[ \t]*(.*)$')
      $role = if ($roleLine.Success) { $roleLine.Groups[1].Value.Trim() } else { '' }
      if (-not $role) {
        Say "$ref carries no clusters/active/$ref.yaml, so it is no cluster's install branch - passed over"
      }
      elseif (Test-RunsHere -Role $role) {
        Publish-BranchPin -Branch $ref
      }
      else {
        Say "$ref carries the $role part and $name runs on $runsOn - passed over"
      }
    }
    if (-not $pinnedAny) {
      Die "no branch of $platformRepo carries a values-$Stage.yaml pin of $name - the images are built and no cluster reads them, so this release reaches nothing"
    }
  }

  Say "$name $tag (commit $sha7) is on its way to $Stage"
  if ($buildNames.Count -gt 0) {
    Say 'the platform builds these image tags, or skips the build when they already exist:'
    foreach ($build in $buildNames) {
      Write-Line "    ${build}:$tag-$sha7"
    }
  }
}
finally {
  if ($platformRepoDir) { Remove-Item -Recurse -Force -LiteralPath $platformRepoDir -ErrorAction SilentlyContinue }
}
