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

for tool in node npm; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on this machine (PATH)"
done

# npm run check = typecheck (tsc) + lint (eslint, no warning allowed) + the boundary law
# (dependency-cruiser) + the CSS tokens (stylelint) + the SPA build (vite). The same command the
# pre-commit hook runs.
echo "check: 1/2 npm run check"
npm run check || fail "npm run check"

# EVERY TEST SUITE: the tests run here before every push and in CI (.github/workflows/tests.yml),
# and a suite this step left out would first be measured after the push. They all run in-process
# or as plain node, with no Docker and no database or Redis server. The one exception is the
# real-serve suites, which start the ansiwise binary pair built in the sibling ansiwise-cli
# checkout: present, they run; absent, ANSIWISE_TESTS_MAY_SKIP lets the run through, and the suites
# that skipped are named below with their reason, never left to read as passed.
echo "check: 2/2 every vitest suite"
report="$(mktemp)" || fail "no temporary file for the test report"
trap 'rm -f "$report"' EXIT
ANSIWISE_TESTS_MAY_SKIP=1 npx vitest run --reporter=default --reporter=json --outputFile.json="$report" || fail "vitest"
node - "$report" <<'JS' || fail "the test report could not be read, so nothing says which suites ran"
const report = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
// A real-serve file skips whole for one reason, and a file whose skip has one known cause says it;
// any other skip is named by its tests' own titles.
const known = { "server/domains/inventory/cluster-marking.test.ts": "no sibling hostyour-deploy checkout beside this one" };
for (const suite of report.testResults) {
  const skipped = suite.assertionResults.filter((t) => t.status !== "passed" && t.status !== "failed");
  if (skipped.length === 0) continue;
  const file = require("node:path").relative(process.cwd(), suite.name);
  const why = file.endsWith(".ansiwise.test.ts")
    ? "needs the ansiwise binary pair (ANSIWISE_BIN and ANSIWISE_REST_BIN, or a built sibling ansiwise-cli)"
    : `${known[file] ?? "skipped"}: ${skipped.map((t) => `"${t.title}"`).join(", ")}`;
  console.log(`check: NOT RUN — ${skipped.length} of ${suite.assertionResults.length} test(s) in ${file}: ${why}`);
}
console.log(`check: tests ${report.numPassedTests} passed, ${report.numTotalTests - report.numPassedTests - report.numFailedTests} not run, ${report.numFailedTests} failed`);
JS
echo "check: OK — lint, types, build and every test suite that runs here green"
