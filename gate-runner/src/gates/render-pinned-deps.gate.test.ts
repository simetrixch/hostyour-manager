// gate-runner/src/gates/render-pinned-deps.gate.test.ts — the PURE dependency-lock check plus the render argv the helm shell
// is handed. The helm/kubeconform execution itself is integration-tested on the live clusters (needs
// the tools), not here.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkDependencyLock, deliveredValues, renderArgs, stagedClusterValuePath, stagedDeliveredValuePath, unitApexOf } from "./render-pinned-deps.gate.ts";
import { clusterMapPath, clusterValueChainPaths, splitAtChartValues } from "../../../shared/cluster-values.ts";

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
  const DOMAIN = "s1.example";
  const chain = clusterValueChainPaths(DOMAIN, "prod").map((p, i) => ({ path: p, staged: stagedClusterValuePath("/ws", i, p) }));
  const split = splitAtChartValues(chain);
  const staged = { beforeChart: split.beforeChart.map((e) => e.staged), afterChart: split.afterChart.map((e) => e.staged) };
  const delivered = stagedDeliveredValuePath("/ws", "prod");

  it("layers the platform files, then the chart's own two, then the cluster's map, then the delivered values — ArgoCD's order — and passes NO --set", () => {
    const args = renderArgs("acme", CHART, "prod", staged, delivered);
    expect(args).toEqual([
      "template",
      "acme",
      CHART,
      "--namespace",
      "acme",
      "-f",
      "/ws/.gate-cluster-values-0-clusters-platform-values-common.yaml",
      "-f",
      "/ws/.gate-cluster-values-1-clusters-platform-values-prod.yaml",
      "-f",
      "deploy/chart/values.yaml",
      "-f",
      "deploy/chart/values-prod.yaml",
      "-f",
      "/ws/.gate-cluster-values-2-clusters-active-s1.example.yaml",
      "-f",
      "/ws/.gate-delivered-values-prod.yaml",
    ]);
    // The cluster's values reach the chart as FILES, exactly as ArgoCD layers them at deploy. A
    // single --set here would be a value the Manager computed, which is the drift this forbids.
    expect(args).not.toContain("--set");
  });

  it("puts the chart's own files BETWEEN the platform pair and the cluster's map, and the delivered values LAST", () => {
    // The position is the whole promise: the chart may override a platform default and may not
    // override the cluster's own map, and that is true at deploy whether or not it is true here.
    // The delivered values sit where the ApplicationSet's valuesObject sits: over everything.
    const args = renderArgs("acme", CHART, "prod", staged, delivered);
    const at = (needle: string): number => args.indexOf(needle);
    expect(at("/ws/.gate-cluster-values-0-clusters-platform-values-common.yaml")).toBeLessThan(at("deploy/chart/values.yaml"));
    expect(at("/ws/.gate-cluster-values-1-clusters-platform-values-prod.yaml")).toBeLessThan(at("deploy/chart/values.yaml"));
    expect(at("deploy/chart/values-prod.yaml")).toBeLessThan(at("/ws/.gate-cluster-values-2-clusters-active-s1.example.yaml"));
    expect(at("/ws/.gate-cluster-values-2-clusters-active-s1.example.yaml")).toBeLessThan(at("/ws/.gate-delivered-values-prod.yaml"));
    expect(args.at(-1)).toBe("/ws/.gate-delivered-values-prod.yaml");
  });

  it("splits the chain at the cluster map, whatever its position in the list", () => {
    // By DIRECTORY, never by index: a platform file added to the chain must not push the cluster's
    // map across the boundary, and the map must land after the chart's files wherever it is listed.
    const shuffled = [{ path: clusterMapPath(DOMAIN) }, { path: "clusters/platform/values-common.yaml" }];
    expect(splitAtChartValues(shuffled)).toEqual({
      beforeChart: [{ path: "clusters/platform/values-common.yaml" }],
      afterChart: [{ path: clusterMapPath(DOMAIN) }],
    });
  });

  it("stages each chain file under a name that still shows its origin and its position", () => {
    expect(chain.map((e) => e.staged)).toEqual([
      "/ws/.gate-cluster-values-0-clusters-platform-values-common.yaml",
      "/ws/.gate-cluster-values-1-clusters-platform-values-prod.yaml",
      "/ws/.gate-cluster-values-2-clusters-active-s1.example.yaml",
    ]);
  });
});

describe("deliveredValues", () => {
  // The two values the consumers ApplicationSet hands every unit as valuesObject, composed by the
  // platform's host law (shared/unit-host.ts): prod stands directly under the unit apex, every other
  // stage under its own zone — so the chart in the sandbox renders the host the deploy serves.
  it("composes a prod unit's host directly under the unit apex", () => {
    expect(parse(deliveredValues("auth", "prod", "digitacloud.app"))).toEqual({
      unitHost: "auth.digitacloud.app",
      global: { stageApex: "digitacloud.app" },
    });
  });

  it("composes a dev unit's host under the dev zone", () => {
    expect(parse(deliveredValues("auth", "dev", "digitacloud.app"))).toEqual({
      unitHost: "auth.dev.digitacloud.app",
      global: { stageApex: "dev.digitacloud.app" },
    });
  });

  it("stages the file per env, beside the chain files", () => {
    expect(stagedDeliveredValuePath("/ws", "test")).toBe("/ws/.gate-delivered-values-test.yaml");
  });
});

describe("unitApexOf", () => {
  const MAP = clusterMapPath("s1.example");

  it("reads global.unitApex off the cluster's map in the chain", () => {
    const chain = [
      { path: "clusters/platform/values-common.yaml", content: "global:\n  timezone: Europe/Amsterdam\n" },
      { path: MAP, content: "global:\n  domain: s1.example\n  unitApex: example.org\n" },
    ];
    expect(unitApexOf(chain)).toBe("example.org");
  });

  it("is null when the map carries no global.unitApex, and when no map is in the chain", () => {
    expect(unitApexOf([{ path: MAP, content: "global:\n  domain: s1.example\n" }])).toBeNull();
    expect(unitApexOf([{ path: "clusters/platform/values-common.yaml", content: "global:\n  unitApex: example.org\n" }])).toBeNull();
    expect(unitApexOf([])).toBeNull();
  });

  it("is null when the map is not YAML", () => {
    expect(unitApexOf([{ path: MAP, content: "global: [\n" }])).toBeNull();
  });
});
