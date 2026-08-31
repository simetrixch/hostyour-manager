#!/usr/bin/env bash
# ===========================================================================
# release.sh — put a release of this repo on ONE stage. Lives in release/;
# copied here by the platform at onboarding. PowerShell twin: release.ps1
# (same folder). The two are held byte-for-byte equivalent in behaviour.
#
# USAGE (run from the repo root)
#   ./release/release.sh <x.y.z> <stable|beta|alpha> <dev|test|prod>
#
# THE THREE INPUTS
#   version  — x.y.z, no leading zeros.
#   channel  — the maturity CEILING of the release: alpha may reach dev only,
#              beta dev and test, stable anywhere. The channel is part of the
#              release tag; the stage is NOT.
#   stage    — WHERE this run puts the release. One release, one image, any
#              number of stages.
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
#      rebuilt: the same commit, the same image, one more stage.
#   6. Deletes and re-pushes the deploy ref refs/tags/deploy/<stage>/<tag>.
#      Pushing that ref is the ONLY build trigger. It is deleted first because
#      pushing a ref that already stands changes nothing and fires no webhook,
#      so a repeat of the same (release, stage) would do nothing at all. The
#      deletion itself fires a webhook too; the platform's trigger drops it.
#   7. Where `platformRepo` is declared: waits for this repo's own
#      release-images run and writes the image pin into that tree.
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

die() { echo "release: $*" >&2; exit 1; }

# THE COMMIT A TAG SITS ON DECLARES THE VERSION THE TAG NAMES. The build reads the version out of
# the tag, so a package.json still declaring an older number labels the artifact with a version
# nobody released. The write happens BEFORE the tag is created: a tag placed first would point at
# the commit that still carries the old number, and a release does not move a tag afterwards.
# Only the FIRST "version" line is touched. That is the manifest's own; a version further down
# belongs to a dependency and is not this release's to move.
# A repository with no package.json, or one that declares no version, has nothing that could go
# stale — that is said out loud and the release continues, because a unit written in another
# language is the ordinary case here and not a broken one.
stamp_manifest_version() {
  file="$ROOT/package.json"
  if [ ! -f "$file" ]; then
    echo "release: this repository carries no package.json — no version manifest to stamp"
    return 0
  fi
  if ! grep -qE '^[[:space:]]*"version":[[:space:]]*"' "$file"; then
    echo "release: package.json declares no version — nothing to stamp"
    return 0
  fi
  sed -i '0,/^\([[:space:]]*\)"version":[[:space:]]*"[^"]*"/s//\1"version": "'"$VERSION"'"/' "$file"
  git diff --quiet -- "$file" && return 0
  git add -- "$file"
  git commit --quiet -m "release: $TAG" || die "the version bump to $VERSION could not be committed"
  echo "release: package.json declares ${VERSION}"
}

# One branch of the platform tree, pinned and pushed. The checkout and the reset onto the remote
# branch are what make the write land on THAT branch and not on whatever the clone had open.
pin_branch() {
  branch="$1"
  git -C "$PLATFORM_REPO_DIR" checkout --quiet "$branch" || die "the platform tree has no branch ${branch} — nothing further was pinned"
  git -C "$PLATFORM_REPO_DIR" reset --quiet --hard "origin/${branch}"
  pinned="$(python3 "$PINNER" "$PLATFORM_REPO_DIR" "$STAGE" "${TAG}-${SHA7}" "$MANIFEST")"
  if [ -z "$pinned" ]; then
    echo "release: ${branch} carries no values-${STAGE}.yaml pin of ${NAME} — left as it stands"
    return 0
  fi
  git -C "$PLATFORM_REPO_DIR" add -- $pinned
  git -C "$PLATFORM_REPO_DIR" commit --quiet -m "Pin ${STAGE} to ${TAG}" -m "Written by the release of ${NAME}, once its images were built."
  git -C "$PLATFORM_REPO_DIR" push --quiet origin "$branch" \
    || die "the pin of ${STAGE} to ${TAG}-${SHA7} could not be pushed to ${branch} of ${PLATFORM_REPO}"
  echo "release: pinned ${branch} to ${TAG}-${SHA7} in ${pinned}"
  PINNED_ANY=1
}

VERSION="${1:-}"
CHANNEL="${2:-}"
STAGE="${3:-}"

[ -n "$VERSION" ] && [ -n "$CHANNEL" ] && [ -n "$STAGE" ] \
  || die "usage: release/release.sh <x.y.z> <stable|beta|alpha> <dev|test|prod>"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || die "version must be x.y.z with no leading zeros (got '$VERSION')"
case "$CHANNEL" in stable|beta|alpha) ;; *) die "channel must be stable|beta|alpha (got '$CHANNEL')" ;; esac
case "$STAGE" in dev|test|prod) ;; *) die "stage must be dev|test|prod (got '$STAGE')" ;; esac

# The courtesy ceiling check. It WARNS and continues on purpose — see the header.
case "$CHANNEL" in
  alpha) ADMITS="dev" ;;
  beta) ADMITS="dev test" ;;
  stable) ADMITS="dev test prod" ;;
esac
case " $ADMITS " in
  *" $STAGE "*) ;;
  *) echo "release: WARNING — channel ${CHANNEL} admits only: ${ADMITS}. Stage ${STAGE} is above its ceiling, so the platform will refuse this run. Pushing anyway; the refusal comes from the pipeline." >&2 ;;
esac

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repository"
[ -z "$(git status --porcelain)" ] || die "worktree is dirty — commit or stash before releasing"

# Anchor the manifest read at the repo root so it resolves whether the script is run from the
# repo root or from inside release/ (git tag/push are already repo-relative, not cwd-relative).
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
MANIFEST="$ROOT/deploy/platform.yaml"

# Read with sed and not grep: `sed -n ... p` answers nothing and exits 0 where a key is absent, so
# a missing platformRepo stays a plain empty value under `set -o pipefail` instead of a failed
# pipeline. The capture stops at the first space, which is also what drops a trailing YAML comment.
manifest_value() { sed -nE "s/^$1:[[:space:]]*([^[:space:]]+).*\$/\\1/p" "$MANIFEST" 2>/dev/null | head -1; }
NAME="$(manifest_value name || true)"
[ -n "$NAME" ] || die "the manifest ${MANIFEST} states no name — it is what the release line and any pin are written under"
PLATFORM_REPO="$(manifest_value platformRepo || true)"

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
    || die "gh is not on this path, so the build of this release could not be waited for and its pin could not be written — nothing has been minted or pushed"
  PLATFORM_REPO_DIR="$(mktemp -d)"
  PINNER="${PLATFORM_REPO_DIR}.pin.py"
  trap 'rm -rf "$PLATFORM_REPO_DIR" "$PINNER"' EXIT
  git clone --quiet "https://github.com/${PLATFORM_REPO}.git" "$PLATFORM_REPO_DIR" \
    || die "the platform tree ${PLATFORM_REPO} could not be cloned, so this release could not write its pin — nothing has been minted or pushed"
  GIT_TERMINAL_PROMPT=0 git -C "$PLATFORM_REPO_DIR" push --dry-run --quiet origin HEAD >/dev/null 2>&1 \
    || die "this machine may not push to ${PLATFORM_REPO}, so this release could not write its pin — nothing has been minted or pushed. A unit that pins itself is released from a machine logged in to both repositories, never from a build runner."
fi

# Remote view first: mint-once has to see the tags other people pushed, or a second machine would
# mint a second tag for the same version+channel instead of reusing the one that exists.
git fetch --tags --quiet origin 2>/dev/null || true

PREFIX="${VERSION}-${CHANNEL}-"
EXISTING="$(git tag -l "${PREFIX}*" | sort | tail -1)"
if [ -n "$EXISTING" ]; then
  TAG="$EXISTING"
  echo "release: reusing the existing release ${TAG} — one release per version+channel, so putting it on ${STAGE} rebuilds nothing"
else
  TS14="$(date -u +%Y%m%d%H%M%S)"
  TAG="${VERSION}-${CHANNEL}-${TS14}"
  stamp_manifest_version
  git tag -a "$TAG" -m "release $TAG"
  git push origin HEAD
  git push origin "refs/tags/${TAG}"
  echo "release: minted ${TAG}"
fi

# The release COMMIT is the tag's, never HEAD — on a reuse, HEAD has usually moved on.
SHA="$(git rev-list -n 1 "$TAG")"
SHA7="${SHA:0:7}"

DEPLOY_REF="refs/tags/deploy/${STAGE}/${TAG}"
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
  echo "release: the manifest ${MANIFEST} names no platformRepo, so nothing is pinned from here — the deploy ref above is what the platform reacts to"
else
  echo "release: waiting for the images of ${TAG} — the pin is written when they exist"
  RUN_ID=""
  for _ in $(seq 1 30); do
    RUN_ID="$(gh run list --workflow release-images --branch "$TAG" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
    [ -n "$RUN_ID" ] && break
    sleep 4
  done
  if [ -z "$RUN_ID" ]; then
    die "no release-images run appeared for ${TAG} within two minutes — the images are unbuilt and nothing was pinned"
  elif ! gh run watch "$RUN_ID" --exit-status --interval 20 >/dev/null 2>&1; then
    echo "release: the images of ${TAG} did not build — no pin was written. Read the run: gh run view ${RUN_ID} --log-failed" >&2
    exit 75
  fi
  echo "release: the images of ${TAG} are built"
  # The clone is as old as the pre-flight, which stands before a build that takes minutes. Refresh
  # the remote-tracking refs, or the reset below writes onto a tip somebody else has moved past and
  # the push is refused for a reason that has nothing to do with this release.
  git -C "$PLATFORM_REPO_DIR" fetch --quiet --prune origin \
    || die "the platform tree ${PLATFORM_REPO} could not be refreshed after the build — the images exist and nothing was pinned"
  # THE PIN GRAMMAR AND NOTHING ELSE: builds[]{name,image,tag}, in the values file of the stage
  # this release is going to. Read and written by name rather than by line, so a file whose
  # entries are ordered differently is still pinned and a file that carries none is left alone.
  cat > "$PINNER" <<'PIN'
import glob, os, re, sys
tree, stage, image_tag, manifest = sys.argv[1:5]
names = re.findall(r"^\s*-\s*name:\s*(\S+)", open(manifest, encoding="utf-8").read(), re.M)
touched = []
for path in glob.glob(os.path.join(tree, "clusters", "inventories", "*", "values-%s.yaml" % stage)):
    text = open(path, encoding="utf-8", newline="").read()
    out, image, changed = [], None, False
    for line in text.split(chr(10)):
        m = re.match(r"^(\s*)image:\s*(\S+)\s*$", line)
        if m:
            image = m.group(2)
        t = re.match(r"^(\s*)tag:\s*\S+\s*$", line)
        if t and image in names:
            line = '%stag: "%s"' % (t.group(1), image_tag)
            image, changed = None, True
        out.append(line)
    # WRITTEN ONLY WHERE A TAG MOVED. A file compared by its whole text is a file rewritten for a
    # trailing newline, and a commit that names files it did not change is one nobody can read.
    new = chr(10).join(out)
    if changed:
        with open(path + ".writing", "w", encoding="utf-8", newline=chr(10)) as f:
            f.write(new)
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
  # WHICH INSTALL BRANCHES: the ones whose own cluster map says `role: master`. A branch states its
  # role in clusters/active/<branch>.yaml, which is read here without checking the branch out. A
  # cluster holding the slave part runs no copy of this unit, so pinning its branch would move a
  # value nothing reads.
  PINNED_ANY=0
  pin_branch master
  for ref in $(git -C "$PLATFORM_REPO_DIR" for-each-ref --format='%(refname:strip=3)' refs/remotes/origin); do
    [ "$ref" = "master" ] && continue
    [ "$ref" = "HEAD" ] && continue
    role="$(git -C "$PLATFORM_REPO_DIR" show "origin/${ref}:clusters/active/${ref}.yaml" 2>/dev/null | grep -m1 -E '^role:' | sed -E 's/^role:[[:space:]]*//' || true)"
    [ "$role" = "master" ] || continue
    pin_branch "$ref"
  done
  [ "$PINNED_ANY" = "1" ] \
    || die "no branch of ${PLATFORM_REPO} carries a values-${STAGE}.yaml pin of ${NAME} — the images are built and no cluster reads them, so this release reaches nothing"
fi

echo "release: ${NAME} ${TAG} (commit ${SHA7}) is on its way to ${STAGE}"
# Read with sed and not grep: under `set -o pipefail` a manifest that declares no builds — a
# chart-only or fan-out unit — would make the pipeline's exit status 1 and end a release that had
# already succeeded. `sed -n ... p` answers nothing and exits 0.
BUILDS="$(sed -nE 's/^[[:space:]]*-[[:space:]]*name:[[:space:]]*([^[:space:]]+).*$/\1/p' "$MANIFEST")"
if [ -n "$BUILDS" ]; then
  echo "release: the platform builds these image tags, or skips the build when they already exist:"
  printf '%s\n' "$BUILDS" | while read -r b; do echo "    ${b}:${TAG}-${SHA7}"; done
fi
