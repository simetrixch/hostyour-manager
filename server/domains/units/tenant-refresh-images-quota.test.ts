import { describe, it, expect } from "vitest";
import { refreshImagesStep, type RefreshImagesParams } from "./tenant-builds.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { useMemoryDb, ports, staleMembers, stepCtx, GUID } from "./tenant-refresh-members.fixture.ts";
import type { TenantRefreshMembersParams } from "./tenant-refresh-members.run.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";

// The re-render after the builds holds a standing tenant against the quota its registration carries
// (the fixture's: base small, 400m of requests), never against a size table default; a new stage
// against the size it is created at.

useMemoryDb();

/** One Deployment of one replica at 150m: two rollouts' worth is 300m, inside the registration's 400m
 *  and above the 200m of the member row at the default size. */
const DOCS: RenderedDoc[] = [{
  apiVersion: "apps/v1", kind: "Deployment", name: "engine", namespace: `${GUID}-erp`,
  raw: { kind: "Deployment", spec: { replicas: 1, template: { spec: { containers: [{ name: "engine", image: "x", resources: { requests: { cpu: "150m", memory: "64Mi" }, limits: { cpu: "300m", memory: "256Mi" } } }] } } } },
}];
const refresh = (size?: "xsmall") => {
  const prt = ports(staleMembers());
  (prt as unknown as { helm: FakeHelmRenderer }).helm = new FakeHelmRenderer({ fallback: { ok: true, docs: DOCS } });
  const p: RefreshImagesParams = {
    guid: GUID, domain: "s1.example", stage: "prod", subdomain: "acme", apps: [{ name: "erp" }], isStandingTenant: true,
    members: staleMembers(), identityProvider: "auth", seedUsers: false, registryHost: "zot.m1.example", requiredImages: [], ...(size ? { size } : {}),
  };
  return refreshImagesStep(prt, p, {}).run(stepCtx(p as unknown as TenantRefreshMembersParams, [], []));
};

describe("refreshImagesStep's quota", () => {
  it("passes a standing tenant whose registration's quota holds the members", async () => {
    await expect(refresh()).resolves.toBeUndefined();
  });

  it("REFUSES a new stage at a size whose quota does not hold them", async () => {
    await expect(refresh("xsmall")).rejects.toThrow(/T5/);
  });
});
