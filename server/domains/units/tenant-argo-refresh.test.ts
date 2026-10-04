import { describe, it, expect, vi } from "vitest";
import { refreshTenantApplications } from "./lifecycle.ts";
import { FakeClusterReader, FakeMasterArgoReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { errUpstream } from "../../kernel/errors.ts";

describe("tenant desired-state refresh", () => {
  const resolverFor = (argoReader: FakeMasterArgoReader) => new FakeClusterKubeResolver({
    argoReader, argoNamespace: "s2", clusterReader: new FakeClusterReader(), projectWriter: new FakeMasterProjectWriter(),
  });

  it("refreshes the native generator before only the affected Applications, in the resolved namespace", async () => {
    const argo = new FakeMasterArgoReader();
    const resolver = resolverFor(argo);
    const log = vi.fn();
    await refreshTenantApplications(resolver, "cluster-two", ["tenant-app-prod", "tenant-auth-prod"], { log });
    expect(resolver.resolved).toEqual(["cluster-two"]);
    expect(argo.operations).toEqual(["refresh-set:s2/tenants", "refresh:s2/tenant-app-prod", "refresh:s2/tenant-auth-prod"]);
    expect(log.mock.calls.flat().join(" ")).toContain("tenant-app-prod, tenant-auth-prod");
  });

  it("does not call the Application refresh or claim success when the generator patch is refused", async () => {
    const argo = new FakeMasterArgoReader({ throwOnRefresh: errUpstream("ApplicationSet patch refused") });
    const log = vi.fn();
    await expect(refreshTenantApplications(resolverFor(argo), "cluster-two", ["tenant-app-prod"], { log })).rejects.toThrow("patch refused");
    expect(argo.refreshed).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});
