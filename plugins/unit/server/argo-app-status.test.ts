import { describe, it, expect } from "vitest";
import type { ArgoAppStatus } from "#core/server/adapters/kube/port.ts";
import { switchValuesSay, tenantRendersSwitch, describeTenantSwitch } from "./argo-app-status.ts";

const DEPLOY = "https://github.com/acme/acme-deploy.git";
const member = (suspended: unknown, over: Partial<ArgoAppStatus> = {}): ArgoAppStatus => ({
  syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy",
  syncSources: [
    // The values-only source of the deploy repository carries no path and no tenant values.
    { repoURL: DEPLOY, revision: "r", path: null },
    { repoURL: DEPLOY, revision: "r", path: "charts/member", valuesObject: { tenant: { suspended } } },
  ],
  ...over,
});

describe("switchValuesSay", () => {
  it("reads an absent value as off, and needs at least one value", () => {
    expect(switchValuesSay([undefined, false], false)).toBe(true);
    expect(switchValuesSay([true, true], true)).toBe(true);
    expect(switchValuesSay([true, false], true)).toBe(false);
    expect(switchValuesSay([], false)).toBe(false);
  });
});

describe("tenantRendersSwitch", () => {
  const names = ["a-auth-prod", "a-web-prod"];

  it("passes once every member renders the flipped value, settled", () => {
    expect(tenantRendersSwitch(names, DEPLOY, "suspended", true)(new Map(names.map((n) => [n, member(true)])))).toBe(true);
  });

  it("PLANTED: one member still rendering the value from before the flip holds the set", () => {
    const byName = new Map([[names[0]!, member(true)], [names[1]!, member(false)]]);
    expect(tenantRendersSwitch(names, DEPLOY, "suspended", true)(byName)).toBe(false);
    expect(describeTenantSwitch(names, DEPLOY, "suspended", true, byName)).toBe("1 of 2 member(s) do not render suspended=true: a-web-prod(suspended=false)");
  });

  it("PLANTED: a member that renders the value but is not settled holds the set", () => {
    const byName = new Map([[names[0]!, member(true)], [names[1]!, member(true, { sync: "OutOfSync" })]]);
    expect(tenantRendersSwitch(names, DEPLOY, "suspended", true)(byName)).toBe(false);
  });

  it("PLANTED: a source of another repository carrying the value is not read", () => {
    const foreign = member(undefined, { syncSources: [{ repoURL: "https://github.com/x/other.git", revision: "r", path: "charts/member", valuesObject: { tenant: { suspended: true } } }] });
    expect(tenantRendersSwitch(["a-auth-prod"], DEPLOY, "suspended", true)(new Map([["a-auth-prod", foreign]]))).toBe(false);
  });
});
