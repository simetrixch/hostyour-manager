#!/usr/bin/env bash
# ===========================================================================
# release.sh — put a release of this repo on ONE stage. Lives in release/;
# copied here by the platform at onboarding. PowerShell twin: release.ps1
# (same folder). The two are held byte-for-byte equivalent in behaviour.
#
# USAGE (run from the repo root)
#   ./release/release.sh <x.y.z> <stable|beta|alpha> <dev|test|prod> [deploy|build]
#
# THE THREE INPUTS
#   version  — x.y.z, no leading zeros.
#   channel  — the maturity CEILING of the release: alpha may reach dev only,
#              beta dev and test, stable anywhere. The channel is part of the
#              release tag; the stage is NOT.
#   stage    — WHERE this run puts the release. One release, one image, any
#              number of stages.
#   target   — optional, `deploy` (the default) or `build`. `build` builds the
#              images for the stage and pins NOTHING: the delivery branch stays
#              where it is and the ref pushed is refs/tags/build/<stage>/<tag>,
#              which the platform builds, scans and verifies without writing the
#              stage's pin. The Manager uses it to build one tenant's version.
#
# WHAT IT DOES
#   1. Validates version, channel and stage.
#   2. Refuses a dirty worktree (a release must be a clean, pushed commit).
#   3. Reads deploy/platform.yaml: the unit `name`, the optional
#      `platformRepo`, and the build names.
#   4. PIN PRE-FLIGHT, only where `platformRepo` is declared: proves this
#      machine can write that tree BEFORE anything is minted (see below).
#   5. MINT-ONCE: exactly one release tag per (version, channel). The first run
#      stamps the version into package.json where the repo has one, mints
#      <x.y.z>-<channel>-<ts14> (ts14 = UTC yyyyMMddHHmmss) on HEAD and pushes
#      the commit + the tag. A later run for the SAME version+channel REUSES
#      that tag — that is how a release reaches a further stage without being
#      rebuilt: the same commit, the same image, one more stage. A VERSION
#      NAMES ONE COMMIT: a rerun whose tag stands on origin on a commit other
#      than HEAD is refused before any push, and the refusal names the next
#      number to mint (#173).
#   6. Places the delivery branch deploy/<stage> on the release commit - the
#      branch the unit's Application renders its chart off - and then
#      deletes and re-pushes the deploy ref refs/tags/deploy/<stage>/<tag>.
#      Pushing that ref is the ONLY build trigger. It is deleted first because
#      pushing a ref that already stands changes nothing and fires no webhook,
#      so a repeat of the same (release, stage) would do nothing at all. The
#      deletion itself fires a webhook too; the platform's trigger drops it.
#   7. Where `platformRepo` is declared: waits for this repo's own
#      release-images run and writes the image pin into that tree, on the
#      trunk and on every install branch whose cluster RUNS this unit.
#
# THE TWO SHAPES THIS ONE SCRIPT SERVES, and what tells them apart
#   A unit whose manifest declares NO platformRepo is built and pinned by the
#   platform's build plane, which the deploy ref above reaches. Steps 4 and 7
#   never run for it: no gh, no python3, no network beyond its own origin.
#   A unit whose manifest DOES declare platformRepo builds its own images in
#   its own repository and its pins live in a tree only a machine is logged in
#   to for writing, so this script waits and writes them itself. The manifest
#   names that tree, so no person has to remember one, and a copy of this
#   script in another repository names its own there and can reach no other.
#
# The stage is never in the release tag — the same image reaches further stages
# by the deploy ref alone. The ceiling below is checked LOCALLY as a courtesy so
# a mistake is visible here, but it does NOT stop the push: the pipeline is the
# only thing that can write, and its refusal — naming channel, stage and the
# allowed stages — is the one that counts. Every property here is re-verified
# there; a hand-forged ref is handled identically.
# ===========================================================================
set -euo pipefail

# WHAT THIS SCRIPT PRINTS, AND WHO WRITES THE NEWLINE. Every line it composes is ASCII, a path it names
# is printed as UTF-8, and every line ends with the
# one \n written here, because neither is the host's to choose. A PowerShell host ends a line with
# two bytes where a shell writes one, and [Console]::Error.WriteLine writes in the console's code
# page, which turns a printed em dash into a different byte on a Windows console — so the twins
# answered differently for two reasons that have nothing to do with the release, and the two are
# held to being byte-for-byte the same. Comments carry whatever characters they like; only what is
# PRINTED is bound.
line() { printf '%s\n' "$*"; }
say() { line "release: $*"; }
warn() { line "release: $*" >&2; }
note() { line "$*" >&2; }
die() { warn "$*"; exit 1; }

# THE COMMIT A TAG SITS ON DECLARES THE VERSION THE TAG NAMES. The build reads the version out of
# the tag, so a package.json still declaring an older number labels the artifact with a version
# nobody released. The write happens BEFORE the tag is created: a tag placed first would point at
# the commit that still carries the old number, and a release does not move a tag afterwards.
# EVERY package.json the repository tracks is stamped, in the one commit: a workspace publishes its
# packages at the numbers they declare, and a package left at an older number is skipped by a publish
# that finds that number already published.
# Only the FIRST "version" line of a file is touched. That is the manifest's own; a version further
# down belongs to a dependency and is not this release's to move. perl rewrites it, because it keeps
# the file's line endings and byte order mark as they are and runs the same on BSD and GNU systems,
# where `sed -i` differs. Paths come unquoted, so a name with a non-ASCII byte is the file itself.
# A repository with no package.json, or a file that declares no version, has nothing that could go
# stale — that is said out loud and the release continues, because a unit written in another
# language is the ordinary case here and not a broken one.
stamp_manifest_version() {
  manifests=$(git -c core.quotePath=false -C "$ROOT" ls-files -- 'package.json' '*/package.json')
  if [ -z "$manifests" ]; then
    say "this repository carries no package.json - no version manifest to stamp"
    return 0
  fi
  stamped=""
  while IFS= read -r rel; do
    file="$ROOT/$rel"
    if ! grep -qE '^[[:space:]]*"version":[[:space:]]*"' "$file"; then
      say "$rel declares no version - nothing to stamp"
      continue
    fi
    VERSION="$VERSION" perl -0pi -e 's/^([ \t]*)"version":[ \t]*"[^"]*"/$1"version": "$ENV{VERSION}"/m' "$file"
    git diff --quiet -- "$file" && continue
    git add -- "$file"
    stamped="$stamped$rel
"
  done <<EOF
$manifests
EOF
  [ -z "$stamped" ] && return 0
  git commit --quiet -m "release: $TAG" || die "the version bump to $VERSION could not be committed"
  printf '%s' "$stamped" | while IFS= read -r rel; do say "$rel declares ${VERSION}"; done
}

# Does this unit run on a cluster whose role is $1? A role names every PART the cluster carries —
# a master carries the slave part as well — while the unit's runsOn names the ONE part it belongs
# to, so the match is against the parts, exactly as the platform-apps ApplicationSet's In selector
# matches them, and `every-cluster` belongs on all of them.
runs_here() {
  local parts
  case "$1" in
    master) parts='master slave' ;;
    *) parts="$1" ;;
  esac
  for where in $RUNS_ON; do
    [ "$where" = "every-cluster" ] && return 0
    for part in $parts; do
      [ "$part" = "$where" ] && return 0
    done
  done
  return 1
}

# One branch of the platform tree, pinned and pushed. The checkout and the reset onto the remote
# branch are what make the write land on THAT branch and not on whatever the clone had open.
#
# THE SUBJECT OPENS WITH `release:` because the platform's push gate excuses a release stamp from
# naming an issue by that word and by nothing else. The clone below carries no hooks, so the gate
# never judges this commit here — but it judges it wherever the same commit is pushed from a
# checkout that does, and a commit the gate refuses from one place is a commit it should refuse
# from every place (#132).
#
# THE BRANCH IS READ AGAIN BEFORE EVERY ATTEMPT. A release waits minutes for its images, and the
# Manager commits to an install branch meanwhile (an onboarding, an offboard): a push onto the head
# this clone saw at its start is then refused, so the pin is written onto the head the remote has
# now and pushed again. A pin that already stands — a rerun — writes nothing and is done.
pin_branch() {
  branch="$1"
  git -C "$PLATFORM_REPO_DIR" checkout --quiet "$branch" || die "the platform tree has no branch ${branch} - nothing further was pinned"
  for attempt in 1 2 3 4 5; do
    git -C "$PLATFORM_REPO_DIR" fetch --quiet origin "$branch" \
      || die "the branch ${branch} of ${PLATFORM_REPO} could not be fetched - nothing further was pinned"
    git -C "$PLATFORM_REPO_DIR" reset --quiet --hard "origin/${branch}"
    pinned="$(python3 "$PINNER" "$PLATFORM_REPO_DIR" "$STAGE" "${TAG}-${SHA7}" "$MANIFEST")" \
      || die "the pin of ${STAGE} could not be written: ${pinned} - the images are built and nothing was pinned"
    if [ -z "$pinned" ]; then
      say "${branch} carries no values-${STAGE}.yaml pin of ${NAME} - left as it stands"
      return 0
    fi
    git -C "$PLATFORM_REPO_DIR" add -- $pinned
    if git -C "$PLATFORM_REPO_DIR" diff --cached --quiet; then
      say "${branch} is pinned to ${TAG}-${SHA7} already - nothing to write"
      PINNED_ANY=1
      return 0
    fi
    git -C "$PLATFORM_REPO_DIR" commit --quiet -m "release: pin ${STAGE} to ${TAG}" -m "Written by the release of ${NAME}, once its images were built."
    if git -C "$PLATFORM_REPO_DIR" push --quiet origin "$branch"; then
      say "pinned ${branch} to ${TAG}-${SHA7} in ${pinned}"
      PINNED_ANY=1
      return 0
    fi
    say "${branch} of ${PLATFORM_REPO} moved on while this release waited (attempt ${attempt} of 5) - pinning again onto its new head"
  done
  die "the pin of ${STAGE} to ${TAG}-${SHA7} could not be pushed to ${branch} of ${PLATFORM_REPO} in 5 attempts"
}

VERSION="${1:-}"
CHANNEL="${2:-}"
STAGE="${3:-}"
TARGET="${4:-deploy}"

[ -n "$VERSION" ] && [ -n "$CHANNEL" ] && [ -n "$STAGE" ] \
  || die "usage: release/release.sh <x.y.z> <stable|beta|alpha> <dev|test|prod> [deploy|build]"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || die "version must be x.y.z with no leading zeros (got '$VERSION')"
case "$CHANNEL" in stable|beta|alpha) ;; *) die "channel must be stable|beta|alpha (got '$CHANNEL')" ;; esac
case "$STAGE" in dev|test|prod) ;; *) die "stage must be dev|test|prod (got '$STAGE')" ;; esac
case "$TARGET" in deploy|build) ;; *) die "target must be deploy|build (got '$TARGET')" ;; esac

# The courtesy ceiling check. It WARNS and continues on purpose — see the header.
case "$CHANNEL" in
  alpha) ADMITS="dev" ;;
  beta) ADMITS="dev test" ;;
  stable) ADMITS="dev test prod" ;;
esac
case " $ADMITS " in
  *" $STAGE "*) ;;
  *) warn "WARNING - channel ${CHANNEL} admits only: ${ADMITS}. Stage ${STAGE} is above its ceiling, so the platform will refuse this run. Pushing anyway; the refusal comes from the pipeline." ;;
esac

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repository"
[ -z "$(git status --porcelain)" ] || die "worktree is dirty - commit or stash before releasing"

# Anchor the manifest read at the repo root so it resolves whether the script is run from the
# repo root or from inside release/ (git tag/push are already repo-relative, not cwd-relative).
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
MANIFEST="$ROOT/deploy/platform.yaml"

# Read with sed and not grep: `sed -n ... p` answers nothing and exits 0 where a key is absent, so
# a missing platformRepo stays a plain empty value under `set -o pipefail` instead of a failed
# pipeline. The capture stops at the first space, which is also what drops a trailing YAML comment.
manifest_value() { sed -nE "s/^$1:[[:space:]]*([^[:space:]]+).*\$/\\1/p" "$MANIFEST" 2>/dev/null | head -1; }
NAME="$(manifest_value name || true)"
[ -n "$NAME" ] || die "the manifest ${MANIFEST} states no name - it is what the release line and any pin are written under"
PLATFORM_REPO="$(manifest_value platformRepo || true)"
# A unit that pins itself writes its pin from here, so a build that pins nothing has no meaning for it.
[ "$TARGET" = "deploy" ] || [ -z "$PLATFORM_REPO" ]   || die "the manifest declares platformRepo ${PLATFORM_REPO}, so this unit writes its own pins - target build is for units the platform's build plane pins"

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
# happens to sit on the machine, and nothing here can touch one.
if [ -n "$PLATFORM_REPO" ]; then
  command -v gh >/dev/null 2>&1 \
    || die "gh is not on this path, so the build of this release could not be waited for and its pin could not be written - nothing has been minted or pushed"
  PLATFORM_REPO_DIR="$(mktemp -d)"
  PINNER="${PLATFORM_REPO_DIR}.pin.py"
  trap 'rm -rf "$PLATFORM_REPO_DIR" "$PINNER"' EXIT
  git clone --quiet "https://github.com/${PLATFORM_REPO}.git" "$PLATFORM_REPO_DIR" \
    || die "the platform tree ${PLATFORM_REPO} could not be cloned, so this release could not write its pin - nothing has been minted or pushed"
  GIT_TERMINAL_PROMPT=0 git -C "$PLATFORM_REPO_DIR" push --dry-run --quiet origin HEAD >/dev/null 2>&1 \
    || die "this machine may not push to ${PLATFORM_REPO}, so this release could not write its pin - nothing has been minted or pushed. A unit that pins itself is released from a machine logged in to both repositories, never from a build runner."
  # WHERE THE UNIT RUNS, which is what decides which branches its pin belongs on. The platform states
  # it PER BUILD and not per unit, and the two are different names: a manifest's `name` is the unit,
  # its `builds[].name` are the workloads, and clusters/inventories is keyed by the workload. This
  # unit is called hostyour-manager and its charts are manager and gate-runner, so a lookup under the
  # unit's own name finds nothing at all.
  #
  # ANY BUILD THAT RUNS SOMEWHERE PUTS THE PIN THERE. The pin is written per build into one values
  # file, so a branch reads it if any build of this unit runs on that cluster. A build carrying no
  # chart - an image a job pulls, never a workload - names no cluster and contributes nothing. `git
  # show` answers 128 for a path the trunk does not carry, and under pipefail that status would be
  # the substitution's and end the release here, so the file is read on its own first.
  RUNS_ON=""
  for build in $(sed -nE 's/^[[:space:]]*-[[:space:]]*name:[[:space:]]*([^[:space:]]+).*$/\1/p' "$MANIFEST"); do
    app="$(git -C "$PLATFORM_REPO_DIR" show "origin/master:clusters/inventories/${build}/app.yaml" 2>/dev/null || true)"
    where="$(printf '%s\n' "$app" | sed -nE '/^runsOn:/{s/^runsOn:[[:space:]]*([^[:space:]]+).*$/\1/p;q;}')"
    [ -n "$where" ] && RUNS_ON="$RUNS_ON $where"
  done
  RUNS_ON="$(printf '%s\n' $RUNS_ON | sort -u | tr '\n' ' ')"
  [ -n "$(printf '%s' "$RUNS_ON" | tr -d ' ')" ] \
    || die "no build of ${NAME} carries a clusters/inventories/<build>/app.yaml on the trunk of ${PLATFORM_REPO} that states runsOn, so where this unit runs is unknown and its pin belongs to no branch in particular - nothing has been minted or pushed"
  say "${NAME} runs on: ${RUNS_ON}"
fi

# Remote view first: mint-once has to see the tags other people pushed, or a second machine would
# mint a second tag for the same version+channel instead of reusing the one that exists.
git fetch --tags --quiet origin 2>/dev/null || true

PREFIX="${VERSION}-${CHANNEL}-"
EXISTING="$(git tag -l "${PREFIX}*" | sort | tail -1)"
HEAD_SHA="$(git rev-parse --verify HEAD)"

# A TAG THAT NEVER REACHED ORIGIN AND NAMES ANOTHER COMMIT IS RESIDUE, and reusing it aims every
# retry at the commit a refused push left behind. The tag is minted before it is pushed, so a push
# the pre-push hook refuses leaves it standing here and nowhere else; the next run finds it, reuses
# it, and is refused again — for the same reason, printed as if it were about the new attempt.
#
# A TAG THAT IS ON ORIGIN IS LEFT EXACTLY AS IT STANDS, whatever commit it names. That is mint-once
# itself, and the reuse below relies on it: one release per version+channel, put on a further stage
# without rebuilding.
if [ -n "$EXISTING" ] \
  && ! git ls-remote --exit-code --tags origin "refs/tags/${EXISTING}" >/dev/null 2>&1 \
  && [ "$(git rev-parse --verify --quiet "${EXISTING}^{commit}")" != "$HEAD_SHA" ]; then
  say "${EXISTING} stands on this machine only and names $(git rev-parse --short=7 "${EXISTING}^{commit}"), not the commit being released. A run whose push was refused left it behind; it is dropped and cut again."
  git tag -d "$EXISTING" >/dev/null \
    || die "the leftover tag ${EXISTING} could not be dropped, and reusing it would release a commit nobody is releasing"
  EXISTING=""
fi

# A VERSION NAMES ONE COMMIT. A tag that survived the residue rule and names a commit other than
# HEAD is on origin, and origin's tag is the release: what stands at HEAD is a different tree, and
# the version cannot name both. Reusing the tag would push its commit to the delivery branch from a
# checkout standing elsewhere - a push the organisation's pre-push hook refuses as "not what is
# checked out", after the tag was reused and in words about the delivery branch. So the refusal is
# here, before any push, and it names the next number: a commit that failed its own push is not
# repaired under its number but succeeded by the next one (#173). The next number is the patch
# plus one. This script reads no other repository, so where one sequence spans several, the person
# holds that the number is still free.
if [ -n "$EXISTING" ] && [ "$(git rev-parse --verify --quiet "${EXISTING}^{commit}")" != "$HEAD_SHA" ]; then
  NEXT="${VERSION%.*}.$(( ${VERSION##*.} + 1 ))"
  die "${EXISTING} stands on origin at $(git rev-parse --short=7 "${EXISTING}^{commit}") and HEAD is $(git rev-parse --short=7 HEAD). A version names one commit, so ${VERSION} is burnt: release ${NEXT} instead. Nothing was pushed."
fi

if [ -n "$EXISTING" ]; then
  TAG="$EXISTING"
  # A TAG ON HEAD THAT NEVER REACHED ORIGIN IS THE RELEASE WITH ITS PUSH STILL OWED (#227): the mint
  # pushed HEAD and the run was cut before the tag's own push landed. Reusing it silently would fire
  # no build and pin nothing; it is pushed now, and the rest of the run proceeds as a reuse.
  if ! git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
    say "${TAG} stands on this machine only, on the commit being released - its push never reached origin; pushed now"
    git push origin HEAD
    git push origin "refs/tags/${TAG}"
  fi
  say "reusing the existing release ${TAG} - one release per version+channel, so putting it on ${STAGE} rebuilds nothing"
else
  TS14="$(date -u +%Y%m%d%H%M%S)"
  TAG="${VERSION}-${CHANNEL}-${TS14}"
  stamp_manifest_version
  git tag -a "$TAG" -m "release $TAG"
  git push origin HEAD
  git push origin "refs/tags/${TAG}"
  say "minted ${TAG}"
fi

# The release COMMIT is the tag's. The rule above makes it HEAD as well, so every push below sends
# what is checked out.
SHA="$(git rev-list -n 1 "$TAG")"
SHA7="${SHA:0:7}"

# ── The delivery branch, placed at the release commit ─────────────────────────
#
# WHAT THE CLUSTER READS. The unit's Application follows `deploy/<stage>` of this repository, not a
# tag: the chart is rendered off that branch and the release pipeline's bump writes the image tags
# into its values there. So the branch has to exist before the deploy ref below starts a build, and
# it has to stand on THIS release's tree - a pin written onto an older tree names images built from
# a chart nobody released.
#
# MOVED AND NOT MERGED. The platform owns this branch. Every release places it on the release
# commit; the bump's pin commits then sit on top of it and are replaced by the next release the same
# way. Nothing a person pushes there survives a release, which is the point: what the cluster runs
# is what was released.
#
# A BUILD PINS NOTHING, so the cluster must not read its tree either: target build leaves the branch
# where the last deploy put it.
if [ "$TARGET" = "deploy" ]; then
  DELIVERY_BRANCH="refs/heads/deploy/${STAGE}"
  git push --force origin "${SHA}:${DELIVERY_BRANCH}"   || die "the delivery branch deploy/${STAGE} could not be placed at ${SHA7}, so the build would have nothing to render"
  say "deploy/${STAGE} stands at ${SHA7}"
fi

DEPLOY_REF="refs/tags/${TARGET}/${STAGE}/${TAG}"
# Delete first (absent on a first deploy — that is the normal case, not an error), then push: the
# push is what the platform's webhook reacts to.
git push origin ":${DEPLOY_REF}" >/dev/null 2>&1 || true
git push origin "${SHA}:${DEPLOY_REF}"

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
# EVERY PATH THAT DOES NOT PIN ENDS THE RUN. A release that says it is on its way to a stage while
# the tree that stage reads still names the previous images is telling the operator something that
# is not so, and the machine is where they find out.
if [ -z "$PLATFORM_REPO" ]; then
  say "the manifest ${MANIFEST} names no platformRepo, so nothing is pinned from here - the deploy ref above is what the platform reacts to"
else
  say "waiting for the images of ${TAG} - the pin is written when they exist"
  RUN_ID=""
  for _ in $(seq 1 30); do
    RUN_ID="$(gh run list --workflow release-images --branch "$TAG" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
    [ -n "$RUN_ID" ] && break
    sleep 4
  done
  if [ -z "$RUN_ID" ]; then
    die "no release-images run appeared for ${TAG} within two minutes - the images are unbuilt and nothing was pinned"
  elif ! gh run watch "$RUN_ID" --exit-status --interval 20 >/dev/null 2>&1; then
    # THE REASON IS PRINTED HERE, not left to a command somebody is told to run next. Whoever reads
    # this failure is standing at a terminal with the credential already in hand, and a release that
    # sends them one round trip away for the cause has answered nothing. The FAILED STEPS and not the
    # whole log: a green build is thousands of lines and they bury the ones that matter.
    note "----- the failed steps of run ${RUN_ID} -----"
    gh run view "$RUN_ID" --log-failed 2>&1 | tail -120 >&2 || note "the log of run ${RUN_ID} could not be read"
    note "----- end of run ${RUN_ID} -----"
    warn "the images of ${TAG} did not build - no pin was written"
    exit 75
  fi
  say "the images of ${TAG} are built"
  # The clone is as old as the pre-flight, which stands before a build that takes minutes. Refresh
  # the remote-tracking refs, or the reset below writes onto a tip somebody else has moved past and
  # the push is refused for a reason that has nothing to do with this release.
  git -C "$PLATFORM_REPO_DIR" fetch --quiet --prune origin \
    || die "the platform tree ${PLATFORM_REPO} could not be refreshed after the build - the images exist and nothing was pinned"
  # THE PIN GRAMMAR AND NOTHING ELSE: builds[]{name,image,tag}, in the values file of the stage
  # this release is going to, and beside a build's tag what its pinValues name. Read and written by
  # name rather than by line, so a file whose entries are ordered differently is still pinned and a
  # file that carries none is left alone. The PowerShell twin is Write-StagePin; the two write the
  # same bytes.
  cat > "$PINNER" <<'PIN'
import glob, os, re, sys
# ONE \n ENDS WHAT THIS PRINTS, as the PowerShell twin ends it. A Windows python ends a printed line
# with \r\n, the shell's $(...) keeps the \r, and every path the answer names would then carry it.
sys.stdout.reconfigure(newline=chr(10))
tree, stage, image_tag, manifest = sys.argv[1:5]
text = open(manifest, encoding="utf-8").read()
names = re.findall(r"^\s*-\s*name:\s*(\S+)", text, re.M)
# WHAT A BUILD PINS BESIDE ITS TAG: its pinValues, a block of `key: "value"` lines under the build,
# each value double-quoted and without a backslash or a double quote in it. Anything else there is
# refused before a file is touched: a value read wrong is a value written wrong.
pins, build, top, block = {}, None, 0, None
for number, line in enumerate(text.split(chr(10)), 1):
    if line.strip() == "" or line.strip().startswith("#"):
        continue
    depth = len(line) - len(line.lstrip(" "))
    if block is not None and depth > block:
        pair = re.match(r'^ +([A-Za-z][A-Za-z0-9_-]*): *"([ !#-\[\]-~]*)"\s*(#.*)?$', line)
        if not pair or pair.group(1) in ("name", "image", "tag"):
            print('line %d is no key: "value" pair of the pinValues of %s' % (number, build))
            sys.exit(3)
        pins[build][pair.group(1)] = pair.group(2)
        continue
    block = None
    item = re.match(r"^( *)-\s*name:\s*(\S+)", line)
    if item:
        build, top = item.group(2), len(item.group(1))
        pins[build] = {}
    elif build is not None and depth <= top:
        build = None
    elif build is not None and re.match(r"^ *pinValues:", line):
        if not re.match(r"^ *pinValues:\s*(#.*)?$", line):
            print('line %d writes the pinValues of %s on one line - write one key: "value" pair per line below it' % (number, build))
            sys.exit(3)
        block = depth
touched = []
for path in glob.glob(os.path.join(tree, "clusters", "inventories", "*", "values-%s.yaml" % stage)):
    lines = open(path, encoding="utf-8", newline="").read().split(chr(10))
    image, changed, i = None, False, 0
    while i < len(lines):
        m = re.match(r"^(\s*)image:\s*(\S+)\s*$", lines[i])
        if m:
            image = m.group(2)
        t = re.match(r"^(\s*)tag:\s*\S+\s*$", lines[i])
        if t and image in names:
            indent = t.group(1)
            lines[i] = '%stag: "%s"' % (indent, image_tag)
            # THE ENTRY is every line around the tag at its indentation or deeper, from below the item
            # line above it to the first shallower line below it. A pin value replaces its key's line
            # there, and stands right after the tag where the entry carries none.
            inside = lambda n: lines[n].strip() == "" or len(lines[n]) - len(lines[n].lstrip(" ")) >= len(indent)
            first, after = i, i + 1
            while first > 0 and inside(first - 1):
                first -= 1
            for key, value in pins.get(image, {}).items():
                end = i + 1
                while end < len(lines) and inside(end):
                    end += 1
                pin = '%s%s: "%s"' % (indent, key, value)
                own = [n for n in range(first, end) if re.match("^" + re.escape(indent + key) + r":(\s|$)", lines[n])]
                if own:
                    lines[own[0]] = pin
                else:
                    lines.insert(after, pin)
                    after += 1
            i = after - 1
            image, changed = None, True
        i += 1
    # WRITTEN ONLY WHERE A TAG MOVED. A file compared by its whole text is a file rewritten for a
    # trailing newline, and a commit that names files it did not change is one nobody can read.
    if changed:
        with open(path + ".writing", "w", encoding="utf-8", newline=chr(10)) as f:
            f.write(chr(10).join(lines))
        os.replace(path + ".writing", path)
        touched.append(os.path.relpath(path, tree).replace(os.sep, "/"))
print(" ".join(touched))
PIN

  # EVERY BRANCH A CLUSTER ACTUALLY READS, and the trunk they are cut from.
  #
  # A cluster's ArgoCD tracks its own INSTALL BRANCH — the root application's targetRevision is the
  # cluster's domain, not the default branch and not a tag — so a pin written only on the trunk is a
  # pin no machine ever sees. It is written on the trunk as well, because an install branch that is
  # regenerated later takes what stands there.
  #
  # WHICH INSTALL BRANCHES: the ones whose cluster RUNS this unit. A branch states its role in
  # clusters/active/<branch>.yaml, which is read here without checking the branch out, and the unit
  # states its runsOn in its inventory — the same two facts the platform-apps ApplicationSet matches
  # to decide which workloads a cluster renders. A cluster that runs no copy of this unit is passed
  # over, because a pin on its branch moves a value nothing there reads.
  #
  # ASKING WHETHER THE BRANCH IS A MASTER instead is a different question with the same answer today,
  # and a wrong answer on the first unit that declares `runsOn: slave` or `every-cluster` and carries
  # a build: its pin would reach no slave branch at all, and the release would report itself on its
  # way to the stage while the machines that run it kept the previous image.
  PINNED_ANY=0
  pin_branch master
  for ref in $(git -C "$PLATFORM_REPO_DIR" for-each-ref --format='%(refname:strip=3)' refs/remotes/origin); do
    [ "$ref" = "master" ] && continue
    [ "$ref" = "HEAD" ] && continue
    role="$(git -C "$PLATFORM_REPO_DIR" show "origin/${ref}:clusters/active/${ref}.yaml" 2>/dev/null | grep -m1 -E '^role:' | sed -E 's/^role:[[:space:]]*//' || true)"
    if [ -z "$role" ]; then
      say "${ref} carries no clusters/active/${ref}.yaml, so it is no cluster's install branch - passed over"
    elif runs_here "$role"; then
      pin_branch "$ref"
    else
      say "${ref} carries the ${role} part and ${NAME} runs on ${RUNS_ON} - passed over"
    fi
  done
  [ "$PINNED_ANY" = "1" ] \
    || die "no branch of ${PLATFORM_REPO} carries a values-${STAGE}.yaml pin of ${NAME} - the images are built and no cluster reads them, so this release reaches nothing"
fi

if [ "$TARGET" = "build" ]; then
  say "${NAME} ${TAG} (commit ${SHA7}) is being built for ${STAGE} - no pin is written, the build is for whoever records its tag"
else
  say "${NAME} ${TAG} (commit ${SHA7}) is on its way to ${STAGE}"
fi
# Read with sed and not grep: under `set -o pipefail` a manifest that declares no builds — a
# chart-only or fan-out unit — would make the pipeline's exit status 1 and end a release that had
# already succeeded. `sed -n ... p` answers nothing and exits 0.
BUILDS="$(sed -nE 's/^[[:space:]]*-[[:space:]]*name:[[:space:]]*([^[:space:]]+).*$/\1/p' "$MANIFEST")"
if [ -n "$BUILDS" ]; then
  say "the platform builds these image tags, or skips the build when they already exist:"
  printf '%s\n' "$BUILDS" | while read -r b; do line "    ${b}:${TAG}-${SHA7}"; done
fi
