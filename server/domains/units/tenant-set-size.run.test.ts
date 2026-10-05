import { describe, it, expect } from "vitest";
import { makeTenantSetSizeDef } from "./set-size.run.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { useMemoryDb, seedTenant, ports, staleMembers, planCtx, GUID } from "./tenant-refresh-members.fixture.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";

// tenant-set-size plans by rendering the tenant's members as they stand and holding them against the
// quota the size asked for resolves to (T5), so a size that cannot hold them twice is refused before any
// registration names it.

useMemoryDb();

/** One member's engine as digita renders it today: 1 CPU and 1Gi at the limit, one replica that surges one. */
const engine: RenderedDoc = {
  apiVersion: "apps/v1", kind: "Deployment", name: "digita-engine", namespace: `${GUID}-erp`,
  raw: { kind: "Deployment", spec: { replicas: 1, template: { spec: { containers: [{ name: "engine", image: "x", resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "1", memory: "1Gi" } } }] } } } },
};
const plan = (size: string, docs?: RenderedDoc[]) => {
  seedTenant();
  const prt = ports(staleMembers());
  if (docs) (prt as unknown as { helm: FakeHelmRenderer }).helm = new FakeHelmRenderer({ fallback: { ok: true, docs } });
  return makeTenantSetSizeDef(prt).planStream!({ tenantId: "tnt_1", size }, planCtx());
};

describe("tenant-set-size plans through the members' render", () => {
  it("plans a size the members fit, and the summary says the figures bound EACH member namespace", async () => {
    const result = await plan("small");
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.plan.summary).toContain("EACH of its member namespaces");
    expect(result.plan.targetKind).toBe("tenant");
  });

  it("REFUSES XS for a member whose pods do not fit its quota twice, naming the member and the figures", async () => {
    const result = await plan("xsmall", [engine]);
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toContain("T5");
    const t5 = (result.planJson as { gates: { id: string; reason: string | null }[] }).gates.find((g) => g.id === "T5");
    expect(t5?.reason).toContain("needs requests 200m/512Mi, limits 2/2Gi, 2 pod(s) and one cert-manager solver pod (requests 10m/64Mi, limits 100m/64Mi, 1 pod(s)), above the quota in requests cpu");
  });

  it("plans the same member at a size whose quota holds it", async () => {
    expect((await plan("small", [engine])).outcome).toBe("planned");
  });
});
