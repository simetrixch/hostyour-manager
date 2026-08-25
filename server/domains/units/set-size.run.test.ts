import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps, tenants, unitSizes } from "../../db/schema/inventory.ts";
import { makeSetSizeDef, makeTenantSetSizeDef } from "./set-size.run.ts";
import { seedUnitSizes } from "./unit-size.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { seedQuota } from "../../../shared/unit-size.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";
import type { LifecyclePorts, TenantLifecyclePorts } from "./lifecycle.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";

// set-size / tenant-set-size — the only path by which a size-table change reaches something already
// deployed. What is asserted is the property the whole design rests on: the run writes the table as it
// stands AT THAT MOMENT, so asking for the size a unit already has is the re-apply and not a no-op.

const GUID = "zsjs023ctne0";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

function ctx(runId: string, stepName: string, params: Record<string, unknown>, logs: string[]): StepCtx {
  return {
    runId, stepName, db: db.db, creds: {} as unknown as CredentialStore, params,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

async function runAll(steps: Step[], params: Record<string, unknown>): Promise<void> {
  for (const step of steps) await step.run(ctx("run_s", step.name, params, []));
}

const ATTESTING = { deployState: { domain: "s1.example", stage: "prod" as const, writtenAt: "x", generation: 1 } };

function consumerPorts(reg: Registrations): LifecyclePorts {
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader(ATTESTING),
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000,
  };
}

function tenantPorts(reg: TenantRegistrations): TenantLifecyclePorts {
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader(ATTESTING),
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: "https://github.com/acme/acme-catalog.git",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    dns: new FakeDnsProvider(),
  };
}

function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

async function seedConsumer(reg: Registrations): Promise<void> {
  seedCluster();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();
  await reg.commitRegistration({
    unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false },
    builds: [],
    deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
    runId: "run_onb",
  });
}

async function seedTenant(reg: TenantRegistrations): Promise<void> {
  seedCluster();
  db.db.insert(tenants).values({
    id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "simetrix.dev", stage: "prod",
    members: ["auth", "jobs", "report"], identityProvider: "auth", suspended: false, status: "active",
  }).run();
  await reg.commitTenant({
    stage: "prod", guid: GUID, runId: "run_crt",
    registration: {
      cluster: "s1", subdomain: "simetrix.dev", apps: [], members: testMembers(), identityProvider: "auth",
      seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false,
    },
  });
}

describe("set-size run (consumer)", () => {
  it("writes the named size's figures into the registration", async () => {
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await seedConsumer(reg);
    const params = { appId: "app_1", size: "large" as const };
    await runAll(makeSetSizeDef(consumerPorts(reg)).steps(params), params);

    expect((await reg.readRegistration("prod", "acme"))?.entry.quota).toEqual(seedQuota("large"));
  });

  it("RE-APPLIES the table: asking for the size it already has writes the table's CURRENT figures", async () => {
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await seedConsumer(reg);
    // The operator raised `small` in the size table. The registration still carries the old figures —
    // that is the whole point of resolving at write time — and nothing has reached the cluster.
    // The BASE row: "acme" brings no database of its own, so its quota is that row alone and a
    // change to it is the whole change.
    db.db.update(unitSizes).set({ requestsCpu: "900m", limitsMemory: "4Gi" }).where(and(eq(unitSizes.component, "base"), eq(unitSizes.name, "small"))).run();
    expect((await reg.readRegistration("prod", "acme"))?.entry.quota?.requestsCpu).toBe("400m");

    const params = { appId: "app_1", size: "small" as const };
    await runAll(makeSetSizeDef(consumerPorts(reg)).steps(params), params);

    const after = (await reg.readRegistration("prod", "acme"))?.entry.quota;
    expect(after?.requestsCpu).toBe("900m");
    expect(after?.limitsMemory).toBe("4Gi");
  });

  it("plans attest-target first, claims the books branch, and says the ceiling evicts nothing", async () => {
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await seedConsumer(reg);
    const plan = await makeSetSizeDef(consumerPorts(reg)).plan({ appId: "app_1", size: "medium" }, { db: db.db });

    expect(plan.targetKind).toBe("app");
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "write-size"]);
    // It COMMITS, unlike restart-workloads — so it claims the shared books worktree, first, exactly as
    // suspend/offboard/migrate do.
    expect(plan.locks).toEqual([
      { resource: "git-branch", key: reg.branch },
      { resource: "git-branch", key: "s1.example" },
      { resource: "master-kube", key: "m" },
    ]);
    // The figures are IN the summary: the operator approves numbers, not a word.
    expect(plan.summary).toContain("800m CPU / 2Gi requested");
    expect(plan.summary).toContain("nothing is evicted");
  });
});

describe("tenant-set-size run", () => {
  it("writes the figures once, and the summary says they bound EACH member namespace", async () => {
    const reg = new TenantRegistrations(new FakePlatformRepo(), async (c) => ({ name: c, stage: "prod" }));
    await seedTenant(reg);
    const params = { tenantId: "tnt_1", size: "medium" as const };
    await runAll(makeTenantSetSizeDef(tenantPorts(reg)).steps(params), params);

    expect((await reg.readTenant("prod", GUID))?.entry.quota).toEqual(seedQuota("medium"));
    const plan = await makeTenantSetSizeDef(tenantPorts(reg)).plan(params, { db: db.db });
    // A tenant owns one namespace per member, so the same figures apply per member — an operator
    // reading "3Gi" must not take it for the tenant's total.
    expect(plan.summary).toContain("EACH of its member namespaces");
    expect(plan.targetKind).toBe("tenant");
  });
});
