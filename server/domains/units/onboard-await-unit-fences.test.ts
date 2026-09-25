import { describe, it, expect } from "vitest";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import { awaitUnitFencesStep, unitFenceApplications } from "./onboard-await-unit-fences.ts";

// The release pipeline refreshes the unit's Application through the argo-sync grant the unit's
// reconciler renders, so the onboarding waits for both per-stage fence Applications before it
// triggers the release — in the ArgoCD namespace the target resolves to (a slave's own on a slave).

const SYNCED: ArgoAppStatus = { syncRevision: "a".repeat(40), targetRevision: null, sync: "Synced", health: "Healthy" };
const p = { consumerName: "acme", stage: "prod", clusterId: "cls_s1" } as DeployableOnboardParams;

function run(statuses: Map<string, ArgoAppStatus>, logs: string[]): Promise<void> {
  const resolver = new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader(), argoReader: new FakeMasterArgoReader({ statuses }),
    projectWriter: new FakeMasterProjectWriter(), argoNamespace: "s1",
  });
  const ports = { resolver, argoWatchTimeoutMs: 1000 } as unknown as OnboardPorts;
  const ctx = { signal: new AbortController().signal, log: (_s: string, t: string) => logs.push(t) } as unknown as StepCtx;
  return awaitUnitFencesStep(ports, p).run(ctx);
}

describe("await-unit-fences", () => {
  it("names the reconciler and the admission policy of the unit's stage, as units-appset.yaml generates them", () => {
    expect(unitFenceApplications("acme", "prod")).toEqual(["acme-reconciler-prod", "acme-admissionpolicy-prod"]);
  });

  it("passes once both stand Synced + Healthy in the target's ArgoCD namespace", async () => {
    const logs: string[] = [];
    await run(new Map([["acme-reconciler-prod", SYNCED], ["acme-admissionpolicy-prod", SYNCED]]), logs);
    expect(logs.join(" ")).toContain("Synced + Healthy in s1");
  });

  it("refuses by name while the reconciler is not rendered, and says why the release waits for it", async () => {
    await expect(run(new Map([["acme-admissionpolicy-prod", SYNCED]]), [])).rejects.toThrow(/acme-reconciler-prod.*argo-sync grant/s);
  });
});
