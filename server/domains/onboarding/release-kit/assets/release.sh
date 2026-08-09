#!/usr/bin/env bash
# ===========================================================================
# release.sh — put a release of this repo on ONE stage. Lives in release/;
# copied here by the platform at onboarding. PowerShell twin: release.ps1
# (same folder).
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
# WHAT IT DOES (and nothing else — it is a DUMB, untrusted client)
#   1. Validates version, channel and stage.
#   2. Refuses a dirty worktree (a release must be a clean, pushed commit).
#   3. MINT-ONCE: exactly one release tag per (version, channel). The first run
#      mints <x.y.z>-<channel>-<ts14> (ts14 = UTC yyyyMMddHHmmss) on HEAD and
#      pushes the commit + the tag. A later run for the SAME version+channel
#      REUSES that tag — that is how a release reaches a further stage without
#      being rebuilt: the same commit, the same image, one more stage.
#   4. Deletes and re-pushes the deploy ref refs/tags/deploy/<stage>/<tag>.
#      Pushing that ref is the ONLY build trigger. It is deleted first because
#      pushing a ref that already stands changes nothing and fires no webhook,
#      so a repeat of the same (release, stage) would do nothing at all. The
#      deletion itself fires a webhook too; the platform's trigger drops it.
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

NAME="$(grep -E '^name:' "$MANIFEST" 2>/dev/null | head -1 | sed -E 's/^name:[[:space:]]*//' || true)"
NAME="${NAME:-<name>}"

echo "release: ${NAME} ${TAG} (commit ${SHA7}) is on its way to ${STAGE}"
echo "release: the platform builds these image tags, or skips the build when they already exist:"
if [ -f "$MANIFEST" ]; then
  grep -E '^[[:space:]]*-[[:space:]]*name:' "$MANIFEST" \
    | sed -E 's/^[[:space:]]*-[[:space:]]*name:[[:space:]]*//' \
    | while read -r b; do [ -n "$b" ] && echo "    ${b}:${TAG}-${SHA7}"; done
fi
