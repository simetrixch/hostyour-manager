#!/usr/bin/env bash
# EVERY CHECK THIS REPOSITORY HAS TO PASS, in order, on the machine of the person who changed it.
#
# One entry point, so the person, the pre-push hook and anybody reading the map all name the same
# thing. scripts/check.ps1 is the Windows entry point and is a shim that starts THIS file, so a
# person working in PowerShell runs these very steps and not a second spelling of them.
#
# The steps stop at the first red one. A step that ran after a failure would print output nobody
# reads, and the line that mattered scrolls off the screen.
#
# A TOOL THAT IS NOT ON THIS MACHINE IS NAMED AND ENDS THE RUN. It is never skipped: a check that
# quietly did not run reads exactly like a check that passed, and the next person believes the tree
# was measured when nothing measured it.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
cd "$root" || exit 1

fail() {
  echo "check: FAIL — $1"
  exit 1
}

for tool in node npm npx; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on this machine (PATH)"
done

# npm run check = typecheck (tsc) + lint (eslint) + the boundary law (dependency-cruiser) +
# the CSS tokens (stylelint) + the SPA build (vite). The same command the pre-commit hook runs.
echo "check: 1/2 npm run check"
npm run check || fail "npm run check"

# Every suite, the fitness checks under fitness/ among them: vitest.config.ts carries them as their
# own project, so this one command is the whole test surface.
echo "check: 2/2 npx vitest run"
npx vitest run || fail "npx vitest run"

echo "check: OK — every check green"
