// gate-runner/src/g3.test.ts — the PURE dependency-lock check plus the render argv the helm shell
// is handed. The helm/kubeconform execution itself is integration-tested on the live clusters (needs
// the tools), not here.
import { describe, expect, it } from "vitest";
import { checkDependencyLock, renderArgs, stagedClusterValuePath } from "./g3.ts";
import { clusterValueChainPaths } from "../../shared/cluster-values.ts";

const CHART = "deploy/chart";

function files(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

describe("checkDependencyLock", () => {
  it("passes a chart with no dependencies", () => {
    const r = checkDependencyLock(files({ "deploy/chart/Chart.yaml": "name: acme\nversion: 1.0.0\n" }), CHART);
    expect(r.ok).toBe(true);
    expect(r.dependencies).toEqual([]);
  });

  it("passes dependencies pinned by a Chart.lock and records the lock digest", () => {
    const r = checkDependencyLock(
      files({
        "deploy/chart/Chart.yaml": "name: acme\ndependencies:\n  - name: redis\n    version: '>=1.0.0'\n    repository: https://charts.example\n",
        "deploy/chart/Chart.lock": "dependencies:\n  - name: redis\n    version: 17.3.1\n    repository: https://charts.example\ndigest: sha256:abcdef\n",
      }),
      CHART,
    );
    expect(r.ok).toBe(true);
    expect(r.dependencies).toEqual([{ name: "redis", version: "17.3.1", digest: "sha256:abcdef" }]);
  });

  it("fails a Chart.lock with no digest", () => {
    const r = checkDependencyLock(
      files({
        "deploy/chart/Chart.yaml": "name: acme\ndependencies:\n  - name: redis\n    version: 17.3.1\n",
        "deploy/chart/Chart.lock": "dependencies:\n  - name: redis\n    version: 17.3.1\n",
      }),
      CHART,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/digest/);
  });

  it("fails a remote dependency with no lock", () => {
    const r = checkDependencyLock(
      files({ "deploy/chart/Chart.yaml": "name: acme\ndependencies:\n  - name: redis\n    version: 17.3.1\n    repository: https://charts.example\n" }),
      CHART,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/remote repository/);
  });

  it("fails a version range with no lock", () => {
    const r = checkDependencyLock(
      files({
        "deploy/chart/Chart.yaml": "name: acme\ndependencies:\n  - name: util\n    version: '^1.0.0'\n    repository: file://../util\n",
        "deploy/chart/charts/util/Chart.yaml": "name: util\nversion: 1.2.0\n",
      }),
      CHART,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exact pin/);
  });

  it("passes an exact-version dependency vendored under charts/ with no remote repo", () => {
    const r = checkDependencyLock(
      files({
        "deploy/chart/Chart.yaml": "name: acme\ndependencies:\n  - name: util\n    version: 1.2.0\n",
        "deploy/chart/charts/util/Chart.yaml": "name: util\nversion: 1.2.0\n",
      }),
      CHART,
    );
    expect(r.ok).toBe(true);
    expect(r.dependencies).toEqual([{ name: "util", version: "1.2.0", digest: "vendored:1.2.0" }]);
  });

  it("fails when the chart path has no Chart.yaml", () => {
    expect(checkDependencyLock(files({}), CHART).ok).toBe(false);
  });
});

describe("renderArgs", () => {
  const stagedChain = clusterValueChainPaths("prod").map((p, i) => stagedClusterValuePath("/ws", i, p));

  it("layers the chart's own values, then the cluster's three chain files, and passes NO --set", () => {
    const args = renderArgs("acme", CHART, "prod", stagedChain);
    expect(args).toEqual([
      "template",
      "acme",
      CHART,
      "--namespace",
      "acme",
      "-f",
      "deploy/chart/values.yaml",
      "-f",
      "deploy/chart/values-prod.yaml",
      "-f",
      "/ws/.gate-cluster-values-0-platform-values-common.yaml",
      "-f",
      "/ws/.gate-cluster-values-1-platform-values-prod.yaml",
      "-f",
      "/ws/.gate-cluster-values-2-installation-profile.yaml",
    ]);
    // The cluster's values reach the chart as FILES, exactly as ArgoCD layers them at deploy. A
    // single --set here would be a value the Controller computed, which is the drift this forbids.
    expect(args).not.toContain("--set");
  });

  it("stages each chain file under a name that still shows its origin and its position", () => {
    expect(stagedChain).toEqual([
      "/ws/.gate-cluster-values-0-platform-values-common.yaml",
      "/ws/.gate-cluster-values-1-platform-values-prod.yaml",
      "/ws/.gate-cluster-values-2-installation-profile.yaml",
    ]);
  });
});
