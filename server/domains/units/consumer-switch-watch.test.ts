import { describe, it, expect } from "vitest";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { rendersSwitch } from "./consumer-switch-watch.ts";

const chart = { repoURL: "https://github.com/x/acme.git", chartPath: "deploy/chart" };
const status = (over: Partial<ArgoAppStatus> = {}): ArgoAppStatus => ({
  syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy",
  syncSources: [{ repoURL: chart.repoURL, revision: "r", path: chart.chartPath, valuesObject: { suspended: false } }],
  ...over,
});

describe("rendersSwitch", () => {
  it("reads the switch off the consumer chart's source", () => {
    expect(rendersSwitch(status(), chart, "suspended", false)).toBe(true);
    expect(rendersSwitch(status(), chart, "suspended", true)).toBe(false);
  });

  it("PLANTED: a status that compared no source of the chart proves nothing, even for the off state", () => {
    expect(rendersSwitch(status({ syncSources: [{ repoURL: "https://github.com/simetrixch/hostyour-cloud.git", revision: "r", path: null }] }), chart, "suspended", false)).toBe(false);
  });

  it("PLANTED: a status read before ArgoCD consumed the refresh proves nothing", () => {
    expect(rendersSwitch(status({ refreshRequested: true }), chart, "suspended", false)).toBe(false);
  });
});
