// The boundary law. These rules are the machine enforcement of
// the 17-law doctrine: one writer per table, one mutation path, IO libs only in adapters/.
// A boundary change is a same-commit edit to this file + the domain README.

// The processes this repo ships, each named by the file that starts it: server/index.ts (the
// package.json `start` script), web/src/main.tsx (the module script in web/index.html, which vite
// builds from root=web), gate-runner/src/cli.ts (the gate-runner Containerfile CMD) and
// server/jobs/registry-reaper.ts (the reaper CronJob command in the manager chart). One pattern,
// used both as the roots of the reachability rule and as its own exemption — a root is not
// reachable from itself.
const ENTRY_POINTS = "^(server/index\\.ts|web/src/main\\.tsx|gate-runner/src/cli\\.ts|server/jobs/registry-reaper\\.ts)$";

module.exports = {
  forbidden: [
    { name: "shared-is-pure", severity: "error",
      comment: "shared/ is types only — it imports nothing from server/ or web/.",
      from: { path: "^shared" }, to: { path: "^(server|web)" } },

    { name: "domains-no-crosstalk", severity: "error",
      comment: "Domains don't import each other (inventory is the shared read exception). Tests may compose across domains.",
      from: { path: "^server/domains/([^/]+)/", pathNot: "\\.test\\.ts$" },
      to: { path: "^server/domains/(?!$1/|inventory/)[^/]+/" } },

    { name: "only-executor-touches-runs-schema", severity: "error",
      from: { pathNot: "^server/executor" }, to: { path: "^server/db/schema/runs" } },

    { name: "only-store-writes-creds", severity: "error",
      from: { pathNot: "^server/security/store" }, to: { path: "^server/db/schema/credentials" } },

    { name: "only-access-writes-operators", severity: "error",
      from: { pathNot: "^server/domains/access|^server/db" }, to: { path: "^server/db/schema/operators" } },

    { name: "only-audit-writer", severity: "error",
      from: { pathNot: "^server/db/audit-writer" }, to: { path: "^server/db/schema/audit" } },

    { name: "adapters-own-io-libs", severity: "error",
      comment: "ssh2 / kube client / openid-client may only be imported inside adapters/.",
      from: { pathNot: "^server/adapters" },
      to: { path: "node_modules/(ssh2|@kubernetes/client-node|openid-client)" } },

    { name: "routes-are-thin", severity: "error",
      comment: "Routes may depend on an adapter PORT (the abstraction, injected) but never on an adapter implementation.",
      from: { path: "routes\\.ts$" }, to: { path: "^server/adapters", pathNot: "port\\.ts$" } },

    { name: "executor-knows-no-domain", severity: "error",
      comment: "The executor is domain-agnostic. Tests may compose across layers.",
      from: { path: "^server/executor", pathNot: "\\.test\\.ts$" }, to: { path: "^server/domains" } },

    { name: "kernel-is-bottom", severity: "error",
      from: { path: "^server/kernel" },
      to: { path: "^server/(domains|executor|adapters|db|http)" } },

    { name: "no-unreachable-modules", severity: "error",
      comment:
        "Every shipped module hangs off one of the ENTRY_POINTS. Tests are deliberately NOT roots, so a " +
        "module that only its own test still imports goes red — that is the leftover this rule exists to " +
        "catch. Reachability, not `orphan`: an orphan needs zero dependencies AND zero dependents, so a " +
        "leftover that itself still imports something could never be caught as one. Exempt alongside the " +
        "tests is the rest of the test surface — the adapter fakes under adapters/*/testing/, the " +
        "*.fixture.ts files and the *.suite.ts files, which exist to serve tests and are reachable from " +
        "nothing else by design. A *.suite.ts holds describe/it blocks that a *.test.ts registers by " +
        "calling it, for the case where two suites must share ONE process-wide fixture and therefore " +
        "cannot be two test files; splitting it out is a split of the FILE, so it is as much test " +
        "surface as the test that calls it.",
      from: { path: ENTRY_POINTS },
      to: {
        path: "^(server|shared|web/src|gate-runner/src)",
        pathNot: [ENTRY_POINTS, "\\.test\\.tsx?$", "\\.d\\.ts$", "^server/adapters/[^/]+/testing/", "\\.fixture\\.ts$", "\\.suite\\.ts$"],
        reachable: false,
      } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
  },
};
