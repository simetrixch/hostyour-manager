import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "../../db/client.ts";
import { openUnitDb } from "#unit/server/plugin.fixture.ts";
import { servers, clusters, apps, tenants } from "../../db/schema/inventory.ts";
import { unitSizes } from "#unit/server/schema.ts";
import { makeSetSizeDef, makeTenantSetSizeDef, TenantSetSizeParams } from "./set-size.run.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { seedQuota, TENANT_BRINGS } from "#unit/shared/unit-size.ts";
import { testMembers, TEST_QUOTA } from "./tenant-members.fixture.ts";
import type { LifecyclePorts, TenantLifecyclePorts } from "./lifecycle.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";

// set-size / tenant-set-size — the only path by which a size-table change reaches something already
// deployed. What is asserted is the property the whole design rests on: the run writes the table as it
// stands AT THAT MOMENT, so asking for the size a unit already has is the re-apply and not a no-op.

const GUID = "zsjs023ctne0";

let db: DbHandle;
beforeEach(() => { db = openUnitDb(); });
afterEach(() => { db.sqlite.close(); });


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

/** The steps read the registrations and the cluster resolver alone; the plan's render is
 *  tenant-set-size.run.test.ts's. */
function tenantPorts(reg: TenantRegistrations): TenantOnboardPorts {
  return ({
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader(ATTESTING),
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    deployRepoUrl: "https://github.com/acme/acme-deploy.git",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    dns: new FakeDnsProvider(),
  } satisfies TenantLifecyclePorts) as unknown as TenantOnboardPorts;
}

function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
}

async function seedConsumer(reg: Registrations, over: { services?: ("postgresql" | "redis")[]; mongodb?: "shared" | "standalone"; redis?: "standalone" } = {}): Promise<void> {
  seedCluster();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", host: "acme", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();
  await reg.commitRegistration({
    unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false },
    builds: [],
    deploy: { stage: "prod", host: "acme", chartPath: "deploy/chart", cluster: "s1", databases: [], keyPatterns: [], channelPatterns: [], services: over.services ?? [], size: "small", mongodb: over.mongodb ?? "shared", ...(over.redis ? { redis: over.redis, redisMaxmemoryPolicy: "noeviction" as const } : {}), quota: seedQuota("small") },
    runId: "run_onb",
  });
}

async function seedTenant(reg: TenantRegistrations): Promise<void> {
  seedCluster();
  db.db.insert(tenants).values({
    id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "example", stage: "prod",
    members: ["auth", "jobs", "report"], identityProvider: "auth", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "", displayName: "", suspended: false, status: "active",
  }).run();
  await reg.commitTenant({
    stage: "prod", guid: GUID, runId: "run_crt",
    registration: {
      cluster: "s1", subdomain: "example", apps: [], members: testMembers(), identityProvider: "auth", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "", displayName: "",
      seedUsers: false, quota: TEST_QUOTA, resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
    },
  });
}

describe("set-size run (consumer)", () => {
  it("writes the named size's word and figures into the registration, so the database presets move with the quota", async () => {
    const reg = new Registrations(new FakePlatformRepo());
    await seedConsumer(reg);
    const params = { appId: "app_1", size: "large" as const };
    await runAll(makeSetSizeDef(consumerPorts(reg)).steps(params), params);

    const entry = (await reg.readRegistration("prod", "acme"))?.entry;
    expect(entry?.quota).toEqual(seedQuota("large"));
    expect(entry?.size).toBe("large");
  });

  it("sizes a Redis of the consumer's own on its own, and keeps its mode and policy", async () => {
    const reg = new Registrations(new FakePlatformRepo());
    await seedConsumer(reg, { services: ["redis"], redis: "standalone" });
    const params = { appId: "app_1", size: "small" as const, sizes: { redis: "large" as const } };
    await runAll(makeSetSizeDef(consumerPorts(reg)).steps(params), params);
    const entry = (await reg.readRegistration("prod", "acme"))?.entry;
    expect([entry?.sizes, entry?.volumes, entry?.redis, entry?.redisMaxmemoryPolicy]).toEqual([{ redis: "large" }, { redis: "2Gi" }, "standalone", "noeviction"]);
    expect(entry?.quota).toEqual(seedQuota("small", { postgresql: false, mongodb: "shared", redis: "standalone" }, { redis: "large" }));
  });

  it("sizes a data part on its own: the part's word moves, its volume stays at the size it was created with", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registrations(repo);
    // Written before parts had sizes: the one word sized PostgreSQL too, and its volume is that
    // preset's.
    await seedConsumer(reg, { services: ["postgresql"] });
    const params = { appId: "app_1", size: "small" as const, sizes: { postgresql: "medium" as const } };
    await runAll(makeSetSizeDef(consumerPorts(reg)).steps(params), params);

    const entry = (await reg.readRegistration("prod", "acme"))?.entry;
    expect(entry?.size).toBe("small");
    expect(entry?.sizes).toEqual({ postgresql: "medium" });
    expect(entry?.volumes).toEqual({ postgresql: "5Gi" });
    expect(entry?.quota).toEqual(seedQuota("small", { postgresql: true, mongodb: "shared" }, { postgresql: "medium" }));

    const again = { appId: "app_1", size: "medium" as const, sizes: { postgresql: "large" as const } };
    await runAll(makeSetSizeDef(consumerPorts(reg)).steps(again), again);
    const after = (await reg.readRegistration("prod", "acme"))?.entry;
    expect([after?.size, after?.sizes, after?.volumes]).toEqual(["medium", { postgresql: "large" }, { postgresql: "5Gi" }]);
  });

  it("keeps a part's size when only the application's is asked for", async () => {
    const reg = new Registrations(new FakePlatformRepo());
    await seedConsumer(reg, { services: ["postgresql"] });
    const params = { appId: "app_1", size: "large" as const };
    await runAll(makeSetSizeDef(consumerPorts(reg)).steps(params), params);
    const entry = (await reg.readRegistration("prod", "acme"))?.entry;
    expect([entry?.size, entry?.sizes, entry?.volumes]).toEqual(["large", { postgresql: "small" }, { postgresql: "5Gi" }]);
  });

  it("writes no sizes or volumes key for a consumer with no data part of its own, never null or a list", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registrations(repo);
    await seedConsumer(reg);
    const params = { appId: "app_1", size: "medium" as const };
    await runAll(makeSetSizeDef(consumerPorts(reg)).steps(params), params);
    const raw = repo.read(repo.booksBranch, "registrations/acme/prod.yaml")!;
    expect(raw).toMatch(/^size: "?medium"?$/m);
    expect(raw).not.toMatch(/^\s*(sizes|volumes):/m);
  });

  it("refuses to plan a data part at or below the frugal default (G24, per part)", async () => {
    const reg = new Registrations(new FakePlatformRepo());
    await seedConsumer(reg, { services: ["postgresql"] });
    await expect(makeSetSizeDef(consumerPorts(reg)).plan({ appId: "app_1", size: "large", sizes: { postgresql: "xsmall" } }, { db: db.db })).rejects.toThrow(/G24|frugal/);
    await expect(makeSetSizeDef(consumerPorts(reg)).plan({ appId: "app_1", size: "large", sizes: { postgresql: "medium" } }, { db: db.db })).resolves.toMatchObject({ kind: "consumer-set-size" });
  });

  it("RE-APPLIES the table: asking for the size it already has writes the table's CURRENT figures", async () => {
    const reg = new Registrations(new FakePlatformRepo());
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
    const reg = new Registrations(new FakePlatformRepo());
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
  it("writes the size word and the member row's figures in one commit", async () => {
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    await seedTenant(reg);
    const params = { tenantId: "tnt_1", size: "medium" as const };
    const before = repo.commits.length;
    await runAll(makeTenantSetSizeDef(tenantPorts(reg)).steps(params), params);

    // The MEMBER row, never base: a tenant member namespace is sized on its own component.
    expect(seedQuota("medium", TENANT_BRINGS)).not.toEqual(seedQuota("medium"));
    const entry = (await reg.readTenant("prod", GUID))?.entry;
    expect(entry?.quota).toEqual(seedQuota("medium", TENANT_BRINGS));
    // The word and the figures in ONE commit, and the word beside the row for the tenant page.
    expect(entry?.size).toBe("medium");
    expect(repo.commits.length - before).toBe(1);
    expect(db.db.select({ size: tenants.size }).from(tenants).where(eq(tenants.id, "tnt_1")).get()?.size).toBe("medium");
  });

  it("takes only a size a tenant is offered: XS to L", () => {
    for (const size of ["xsmall", "small", "medium", "large"]) expect(TenantSetSizeParams.safeParse({ tenantId: "tnt_1", size }).success, size).toBe(true);
    for (const size of ["xlarge", "xxlarge"]) expect(TenantSetSizeParams.safeParse({ tenantId: "tnt_1", size }).success, size).toBe(false);
  });
});
