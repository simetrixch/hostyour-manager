import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { tenantTeardownMembers, tenantWatchMembers, tenantWatchSet } from "./tenant-lifecycle.run.ts";
import { makeOffboardTenantDef } from "./tenant-offboard.run.ts";
import { makeTenantPurgeDef, type TenantPurgeParams } from "./tenant-purge.run.ts";
import { resolveTeardownTarget } from "./tenant-replace.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { renderTenantAppProject } from "./appproject.ts";
import { renderTenantMemberAdmissionPolicy, tenantMemberAdmissionPolicyName } from "./admission-policy.ts";
import { loadTenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { memberAppProject, memberApplication, tenantApplicationSet } from "./tenant-fanout.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { PlanStreamCtx, Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import type { TenantStatus } from "../../../shared/enums.ts";
import { ARGO_NS, STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";

// The member set a TEARDOWN takes down (tenantTeardownMembers), across the three runs that tear a
// tenant down: tenant-offboard, tenant-purge and the create-tenant replace's resolver. A member's
// AppProject and admission policy are written by the Manager at create-tenant or add-app and removed by
// nothing but a teardown — no status flip touches either — so the set is every app row whatever its
// status, while a LIVE tenant's watch keeps its filter (tenantWatchMembers): a Synced/Healthy watch
// over a name ArgoCD never creates hangs, a prune watch over it passes at once.
//
// Its own sibling file: the three files that own these runs' other tests sit at the 400-line budget.

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const SUB = "simetrix";
const DEPLOY_REPO = "https://github.com/acme/acme-catalog.git";
const PLATFORM_REPO = "https://github.com/simetrixch/hostyour-cloud.git";
const THREE_APPS = ["erp", "web", "buildproject"];
const APP_ENTRIES = THREE_APPS.map((name) => ({ name, seedReference: false, seedDemo: false, selections: {} }));
// The standing members in the row's own order, then the app rows by name.
const SIX = [...TEST_MEMBERS, ...[...THREE_APPS].sort()];

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function entry(over: Partial<TenantRegistration> = {}): TenantRegistration {
  return {
    cluster: "s1", subdomain: SUB, identityProvider: "auth", routing: "host", ownDomain: "",
    members: testMembers(APP_ENTRIES), apps: APP_ENTRIES,
    seedUsers: false, quota: seedQuota("small"), resetNonce: "1", suspended: false, quiesced: false,
    appsImage: "", appsImageTag: "",
    ...over,
  };
}

type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

function ports(reg: TenantRegistrations, over: FakeKube = {}): TenantLifecyclePorts {
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: over.cluster ?? new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } }),
      argoReader: over.argo ?? new FakeMasterArgoReader(), // no scripted statuses ⇒ every name reads Missing (pruned)
      projectWriter: over.projects ?? new FakeMasterProjectWriter(),
      argoNamespace: ARGO_NS,
    }),
    catalogRepoUrl: DEPLOY_REPO,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    dns: new FakeDnsProvider(),
  };
}

function ctx(runId: string, stepName: string, params: Record<string, unknown>, logs: string[]): StepCtx {
  return {
    runId, stepName, db: db.db, creds: {} as unknown as CredentialStore, params,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function planCtx(logs: string[]): PlanStreamCtx {
  return { db: db.db, log: (l) => logs.push(l), signal: new AbortController().signal };
}

/** The cluster, the tenants row and one app row per name — the app rows at `appStatus`, which is
 *  separate from the tenant's own status because the teardown set is keyed on the row's, not the
 *  tenant's. */
function seedTenant(opts: { status?: TenantStatus; appStatus?: TenantStatus; apps?: string[] } = {}): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "1.2.3.4", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: SUB, stage: "prod", members: TEST_MEMBERS, identityProvider: "auth", status: opts.status ?? "active" }).run();
  for (const name of opts.apps ?? THREE_APPS) db.db.insert(tenantApps).values({ id: `tna_${name}`, tenantId: "tnt_1", name, status: opts.appStatus ?? "active" }).run();
}

/** One AppProject and one admission policy per member, as create-tenant's apply-appprojects leaves them. */
async function standUp(projects: FakeMasterProjectWriter, cluster: FakeClusterReader, members: readonly string[]): Promise<void> {
  for (const member of members) {
    await projects.applyAppProject(ARGO_NS, renderTenantAppProject({ guid: GUID, member, stage: "prod", argoNamespace: ARGO_NS, catalogRepoUrl: DEPLOY_REPO, platformRepoURL: PLATFORM_REPO, cluster: "s1" }));
    const { policy, binding } = renderTenantMemberAdmissionPolicy({ guid: GUID, member, stage: "prod" });
    await cluster.applyAdmissionPolicy(policy, binding);
  }
}

function expectGone(projects: FakeMasterProjectWriter, cluster: FakeClusterReader, members: readonly string[]): void {
  for (const member of members) {
    expect(projects.get(ARGO_NS, memberAppProject(GUID, member, "prod"))).toBeUndefined();
    expect(cluster.admissionPolicies.has(tenantMemberAdmissionPolicyName(GUID, member, "prod"))).toBe(false);
  }
}

/** The one log line of a member-wide delete names every AppProject and every policy it deleted. */
function expectNamed(line: string, members: readonly string[]): void {
  expect(line).toContain(`member AppProjects: ${members.length} deleted (`);
  expect(line).toContain(`admission policies: ${members.length} deleted (`);
  expect(line).toContain("0 already absent (none)");
  for (const member of members) {
    expect(line).toContain(memberAppProject(GUID, member, "prod"));
    expect(line).toContain(tenantMemberAdmissionPolicyName(GUID, member, "prod"));
  }
}

function syncedMap(names: readonly string[]): Map<string, ArgoAppStatus> {
  const m = new Map<string, ArgoAppStatus>();
  for (const n of names) m.set(n, { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" });
  return m;
}

async function runAll(steps: Step[], runId: string, params: Record<string, unknown>, logs: string[]): Promise<void> {
  for (const step of steps) await step.run(ctx(runId, step.name, params, logs));
}

async function plannedPurge(prt: TenantLifecyclePorts, logs: string[]): Promise<TenantPurgeParams> {
  const result = await makeTenantPurgeDef(prt).planStream!({ guid: GUID, stage: "prod", clusterId: "cls_1" }, planCtx(logs));
  if (result.outcome !== "planned") throw new Error(`expected a planned outcome, got ${result.outcome}`);
  return result.params;
}

describe("the two member readers", () => {
  it("tenantTeardownMembers names every app row whatever its status; tenantWatchMembers keeps only the live ones", () => {
    seedTenant({ appStatus: "offboarded" });
    expect(tenantTeardownMembers(db.db, GUID, "prod")).toEqual(SIX);
    expect(tenantWatchMembers(db.db, "tnt_1")).toEqual(TEST_MEMBERS);
    // The Synced/Healthy watches of a live tenant follow the live reader, so a settled row cannot hang them.
    expect(tenantWatchSet(db.db, loadTenantCluster(db.db, "tnt_1"))).toEqual(tenantApplicationSet(TEST_MEMBERS, GUID, "prod"));
  });

  it("reads the row whatever ITS status, and nothing where the inventory never recorded the tenant", () => {
    seedTenant({ status: "purged", appStatus: "purged" });
    expect(tenantTeardownMembers(db.db, GUID, "prod")).toEqual(SIX);
    expect(tenantTeardownMembers(db.db, "nobody000000", "prod")).toEqual([]);
  });
});

describe("tenant-offboard of a tenant whose app rows are SETTLED", () => {
  it("watch-removal waits for a settled app member's Application too — one that lingers fails the offboard", async () => {
    seedTenant({ appStatus: "offboarded" });
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    argo.setStatuses(syncedMap([memberApplication(GUID, "web", "prod")])); // everything pruned EXCEPT the settled app member
    const steps = makeOffboardTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" });
    await steps[0]!.run(ctx("run_off", "attest-target", {}, []));
    await steps[1]!.run(ctx("run_off", "remove-apps-registration", {}, []));
    await steps[2]!.run(ctx("run_off", "remove-tenant", {}, []));
    await expect(steps[3]!.run(ctx("run_off", "watch-removal", {}, []))).rejects.toThrow(`${memberApplication(GUID, "web", "prod")}=Healthy`);
  });

  it("deletes SIX AppProjects and SIX admission policies, waits for six Applications, and names every one deleted", async () => {
    seedTenant({ appStatus: "offboarded" });
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const projects = new FakeMasterProjectWriter();
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    await standUp(projects, cluster, SIX);

    const logs: string[] = [];
    await runAll(makeOffboardTenantDef(ports(reg, { projects, cluster })).steps({ tenantId: "tnt_1" }), "run_off", { tenantId: "tnt_1" }, logs);

    expect(logs.some((l) => l.includes("fan-out pruned (6 Application(s))"))).toBe(true);
    expectGone(projects, cluster, SIX);
    expect(cluster.deletedAdmissionPolicies).toEqual(SIX.map((m) => tenantMemberAdmissionPolicyName(GUID, m, "prod")));
    expectNamed(logs.find((l) => l.startsWith("member AppProjects:"))!, SIX);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("offboarded");
  });

  it("delete-appprojects names the members it found already absent, one by one", async () => {
    seedTenant({ appStatus: "purged" });
    const del = makeOffboardTenantDef(ports(new TenantRegistrations(new FakePlatformRepo()))).steps({ tenantId: "tnt_1" }).find((s) => s.name === "delete-appprojects")!;
    const logs: string[] = [];
    await del.run(ctx("run_off", "delete-appprojects", {}, logs));
    const line = logs.at(-1)!;
    expect(line).toContain("member AppProjects: 0 deleted (none), 6 already absent (");
    expect(line).toContain("admission policies: 0 deleted (none), 6 already absent (");
    for (const member of SIX) expect(line).toContain(memberAppProject(GUID, member, "prod"));
  });
});

describe("resolveTeardownTarget — the replace's and the purge's member set", () => {
  it("a SETTLED app row is still a member of the target — its AppProject and policy outlive the status flip", async () => {
    // The pointer names erp alone; the inventory records three app rows, two of them settled. The union
    // keeps the pointer's order and adds what only the inventory records, by name.
    seedTenant({ appStatus: "offboarded" });
    db.db.update(tenantApps).set({ status: "purged" }).where(eq(tenantApps.id, "tna_buildproject")).run();
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ apps: [APP_ENTRIES[0]!], members: testMembers([APP_ENTRIES[0]!]) }), runId: "run_onb" });
    const target = await resolveTeardownTarget({ db: db.db, registrations: reg }, "prod", GUID);
    expect(target?.tenantId).toBe("tnt_1");
    expect(target?.members).toEqual([...TEST_MEMBERS, "erp", "buildproject", "web"]);
    expect(target?.watchNames).toEqual(tenantApplicationSet([...TEST_MEMBERS, "erp", "buildproject", "web"], GUID, "prod"));
  });
});

describe("tenant-purge of the same tenant", () => {
  it("by guid, with a live row whose app rows are SETTLED: deletes every app member's AppProject and admission policy too", async () => {
    seedTenant({ status: "provisioning", appStatus: "offboarded" }); // a purge is legitimately for a tenant whose create never finished
    const reg = new TenantRegistrations(new FakePlatformRepo());
    // The pointer names erp alone, so web and buildproject reach the target through the inventory only.
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ apps: [APP_ENTRIES[0]!], members: testMembers([APP_ENTRIES[0]!]) }), runId: "run_onb" });
    const projects = new FakeMasterProjectWriter();
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    await standUp(projects, cluster, SIX);
    const prt = ports(reg, { projects, cluster });

    const logs: string[] = [];
    const params = await plannedPurge(prt, logs);
    expect(params.target.tenantId).toBe("tnt_1");
    expect(new Set(params.target.members)).toEqual(new Set(SIX));
    expect(params.target.watchNames).toEqual(tenantApplicationSet(params.target.members, GUID, "prod"));
    await runAll(makeTenantPurgeDef(prt).steps(params), "run_tpurge", params, logs);

    expectGone(projects, cluster, SIX);
    expectNamed(logs.find((l) => l.includes("member AppProjects:"))!, params.target.members);
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.tenantId, "tnt_1")).all().map((a) => a.status)).toEqual(["purged", "purged", "purged"]);
  });

  it("AFTER an offboard — row settled, pointer gone — still names the members the row recorded and deletes what the offboard left", async () => {
    // No LIVE source names the tenant, so the target is built by guid; the inventory still records
    // what the tenant was made of, and an AppProject or a policy the offboard did not reach is exactly
    // what this purge is for. The subdomain is NOT taken off the settled row: the wildcard may belong to
    // whoever took the subdomain since, and remove-dns deletes by name.
    seedTenant({ status: "offboarded", appStatus: "offboarded" });
    const projects = new FakeMasterProjectWriter();
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    await standUp(projects, cluster, SIX);
    const prt = ports(new TenantRegistrations(new FakePlatformRepo()), { projects, cluster }); // no pointer

    const planLogs: string[] = [];
    const params = await plannedPurge(prt, planLogs);
    expect(params.target).toEqual({ guid: GUID, subdomain: "", stage: "prod", clusterId: "cls_1", cluster: "s1", tenantId: null, watchNames: tenantApplicationSet(SIX, GUID, "prod"), members: SIX });
    expect(planLogs.some((l) => l.includes("6 recorded member AppProject(s) and admission policies"))).toBe(true);
    const logs: string[] = [];
    await runAll(makeTenantPurgeDef(prt).steps(params), "run_tpurge", params, logs);

    expectGone(projects, cluster, SIX);
    expectNamed(logs.find((l) => l.includes("member AppProjects:"))!, SIX);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("purged");
  });
});
