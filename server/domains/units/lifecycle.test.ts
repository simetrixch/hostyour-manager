import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { assertDeployState, loadTenantCluster, attestTenantTargetStep, type TenantLifecyclePorts } from "./lifecycle.ts";
import { FakeClusterReader, FakeMasterArgoReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { AppError } from "../../kernel/errors.ts";
import type { DeployState } from "../../adapters/kube/port.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";

const GUID = "e2e8ymj86dk8";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function seedTenant(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "simetrix.dev", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth" }).run();
}

// attest-target reads only ctx.db + the resolved clusterReader, so the rest of the ports (registrations)
// are irrelevant here — cast a partial to keep the test decoupled from the sibling TenantRegistrations. The
// resolver's master path yields the scripted deploy-state reader.
function tenantPorts(deployState: DeployState | null): TenantLifecyclePorts {
  return {
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState }),
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000,
    catalogRepoUrl: "https://github.com/acme/acme-catalog.git",
  } as unknown as TenantLifecyclePorts;
}

function ctx(logs: string[]): StepCtx {
  return {
    runId: "run_t", stepName: "attest-target", db: db.db, creds: {} as unknown as CredentialStore, params: { tenantId: "tnt_1" },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const state = (over: Partial<DeployState> = {}): DeployState => ({ domain: "s1.example", stage: "prod", writtenAt: "x", generation: 7, ...over });

describe("assertDeployState", () => {
  it("returns the state when domain + stage agree", () => {
    expect(assertDeployState(state(), "s1.example", "prod", "tenant").generation).toBe(7);
  });

  it("throws on an absent deploy-state (unprovisioned cluster)", () => {
    expect(() => assertDeployState(null, "s1.example", "prod", "tenant")).toThrow(/refusing to act on an unprovisioned cluster/);
  });

  it("throws on a domain/stage mismatch, naming the subject", () => {
    expect(() => assertDeployState(state({ stage: "test" }), "s1.example", "prod", "tenant")).toThrow(/tenant targets s1.example\/prod/);
  });
});

describe("loadTenantCluster", () => {
  it("resolves the tenant row + its cluster context", () => {
    seedTenant();
    const tc = loadTenantCluster(db.db, "tnt_1");
    expect(tc).toEqual({
      tenantId: "tnt_1", guid: GUID, subdomain: "simetrix.dev", stage: "prod",
      domain: "s1.example", clusterId: "cls_1",
      // The tenant's own recorded facts ride along: every caller that names a namespace, an
      // AppProject or the tenant's auth host reads them from here.
      members: ["auth", "jobs", "report"], identityProvider: "auth",
    });
  });

  it("throws NOT_FOUND on an unknown tenant", () => {
    expect(() => loadTenantCluster(db.db, "tnt_missing")).toThrow(AppError);
  });
});

describe("attestTenantTargetStep", () => {
  it("is the first step id (attest-target) and logs the attested generation", async () => {
    seedTenant();
    const step = attestTenantTargetStep(tenantPorts(state()), "tnt_1");
    expect(step.name).toBe("attest-target");
    const logs: string[] = [];
    await step.run(ctx(logs));
    expect(logs.some((l) => l.includes(`${GUID}`) && l.includes("generation 7"))).toBe(true);
  });

  it("fails closed when the cluster reports a different domain/stage", async () => {
    seedTenant();
    const step = attestTenantTargetStep(tenantPorts(state({ stage: "test" })), "tnt_1");
    await expect(step.run(ctx([]))).rejects.toThrow(/deploy-state mismatch/);
  });

  it("fails closed when the cluster has no deploy-state", async () => {
    seedTenant();
    const step = attestTenantTargetStep(tenantPorts(null), "tnt_1");
    await expect(step.run(ctx([]))).rejects.toThrow(/unprovisioned cluster/);
  });
});
