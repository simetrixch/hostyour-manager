import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makePurgeAppDef } from "./tenant-purge-app.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { fakeTenantSeeder } from "./tenant-seeder.fixture.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { renderTenantAppProject } from "./appproject.ts";
import { memberAppProject, memberApplication, memberNamespace } from "./tenant-fanout.ts";
import { tenantMemberAdmissionPolicyName } from "./admission-policy.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TenantStatus } from "../../../shared/enums.ts";

// tenant-purge-app: an app that tenant-remove-app took off a standing tenant leaves its record, its
// AppProject, its admission policy and its Vault keys behind on purpose. The purge deletes exactly
// those of that one app, each named in the plan, and then the record; nothing of another app or
// another tenant. It deletes the app's member namespace where one stands empty, since remove-app has
// already dropped its databases. It refuses an app that is still deployed (a workload or a ServiceClaim
// in its namespace, or its Application), an app that is not offboarded, and a tenant that is not standing.

const GUID = "zsjs023ctne0";
const OTHER_GUID = "a1b2c3d4e5f6";
const PARAMS = { tenantId: "tnt_1", app: "web" };

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function seedTenants(opts: { webStatus?: TenantStatus; tenantStatus?: TenantStatus } = {}): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  for (const [id, guid, status] of [["tnt_1", GUID, opts.tenantStatus ?? "active"], ["tnt_2", OTHER_GUID, "active"]] as const) {
    db.db.insert(tenants).values({
      id, clusterId: "cls_1", guid, subdomain: id, stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", ownDomain: "", ownDomainRedirects: [], approvedTags: {},
      suspended: false, status,
    }).run();
  }
  db.db.insert(tenantApps).values({ id: "tna_erp", tenantId: "tnt_1", name: "erp", status: "active" }).run();
  db.db.insert(tenantApps).values({ id: "tna_web", tenantId: "tnt_1", name: "web", status: opts.webStatus ?? "offboarded" }).run();
  // Another tenant's app of the same name, offboarded too: the purge must never reach it.
  db.db.insert(tenantApps).values({ id: "tna_web2", tenantId: "tnt_2", name: "web", status: "offboarded" }).run();
}

const project = (guid: string, member: string) => renderTenantAppProject({
  guid, member, stage: "prod", argoNamespace: "argocd", deployRepoUrl: "https://github.com/acme/acme-deploy.git",
  platformRepoURL: "https://github.com/simetrixch/hostyour-cloud.git", cluster: "s1",
});

/** The cluster, master and Vault as a remove-app leaves them: `web`'s namespace and Application gone,
 *  its AppProject, admission policy and Vault keys kept, unless a test says otherwise. A namespace that
 *  stands is empty unless `workloads` or `serviceClaims` put something in it. A sibling app and the other
 *  tenant's `web` keep their own pieces throughout. */
async function world(left: { namespace?: boolean; workloads?: string[]; serviceClaims?: string[]; application?: boolean; project?: boolean; policy?: boolean; vaultKeys?: string[]; registered?: boolean } = {}) {
  const ns = memberNamespace(GUID, "web", "prod");
  const cluster = new FakeClusterReader({
    deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 },
    absentNamespaces: left.namespace || left.workloads || left.serviceClaims ? [] : [ns],
    smokeByNamespace: { [ns]: { namespaceExists: true, externalSecretsReady: true, workloads: (left.workloads ?? []).map((name) => ({ kind: "Deployment", name, available: false, desired: 0, ready: 0 })) } },
    serviceClaimsByNamespace: { [ns]: left.serviceClaims ?? [] },
  });
  const policies = [tenantMemberAdmissionPolicyName(GUID, "erp", "prod"), tenantMemberAdmissionPolicyName(OTHER_GUID, "web", "prod")];
  if (left.policy ?? true) policies.push(tenantMemberAdmissionPolicyName(GUID, "web", "prod"));
  for (const name of policies) cluster.admissionPolicies.set(name, {} as never);
  const argo = new FakeMasterArgoReader(left.application ? { status: { syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy" } } : {});
  const projects = new FakeMasterProjectWriter();
  await projects.applyAppProject("argocd", project(GUID, "erp"));
  await projects.applyAppProject("argocd", project(OTHER_GUID, "web"));
  if (left.project ?? true) await projects.applyAppProject("argocd", project(GUID, "web"));
  const vaultKeys = left.vaultKeys ?? ["password-field-key/web", "service-key/web"];
  const vaultDeletes: unknown[] = [];
  const seeder = {
    ...fakeTenantSeeder(),
    listTenantAppKeys: async () => vaultKeys,
    deleteTenantAppKeys: async (input: unknown) => { vaultDeletes.push(input); return { deleted: vaultKeys }; },
  };
  // The tenant's registration names its standing apps; a removed app is no longer among them.
  const registrations = new TenantRegistrations(new FakePlatformRepo());
  const apps = [{ name: "erp", seedReference: false, seedDemo: false, selections: {} }, ...(left.registered ? [{ name: "web", seedReference: false, seedDemo: false, selections: {} }] : [])];
  await registrations.commitTenant({
    stage: "prod", guid: GUID, runId: "run_onb",
    registration: {
      cluster: "s1", members: testMembers(apps), identityProvider: "auth", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "", displayName: "",
      subdomain: "simetrix", apps, seedUsers: false, quota: seedQuota("small"), resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
    },
  });
  const ports: TenantLifecyclePorts = {
    registrations,
    resolver: new FakeClusterKubeResolver({ clusterReader: cluster, argoReader: argo, projectWriter: projects, argoNamespace: "argocd" }),
    deployRepoUrl: "https://github.com/acme/acme-deploy.git",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    seeder,
  };
  return { ports, cluster, projects, vaultDeletes };
}

function ctx(runId: string, stepName: string, logs: string[]): StepCtx {
  return {
    runId, stepName, db: db.db, creds: {} as unknown as CredentialStore, params: PARAMS,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

// The app's live record: a deleted one stays as a row, and every read skips it.
const appRow = (tenantId: string, name: string) => db.db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, tenantId), eq(tenantApps.name, name), isNull(tenantApps.deleted))).get();
const tenantRow = (id: string) => db.db.select().from(tenants).where(eq(tenants.id, id)).get();
const runAll = async (def: ReturnType<typeof makePurgeAppDef>, logs: string[] = []) => {
  for (const step of def.steps(PARAMS)) await step.run(ctx("run_purge", step.name, logs));
};

describe("tenant-purge-app run", () => {
  it("PLANTED DEFECT: deletes the app's AppProject, admission policy and Vault keys and then its record, each named in the plan, and nothing of another app or tenant", async () => {
    seedTenants();
    const { ports, cluster, projects, vaultDeletes } = await world();
    const def = makePurgeAppDef(ports);
    const plan = await def.plan(PARAMS, { db: db.db } as never);
    for (const piece of [
      `AppProject ${memberAppProject(GUID, "web", "prod")}`,
      `admission policy ${tenantMemberAdmissionPolicyName(GUID, "web", "prod")} with its binding`,
      `Vault key prod/tenants/${GUID}/password-field-key/web`,
      `Vault key prod/tenants/${GUID}/service-key/web`,
    ]) expect(plan.summary).toContain(piece);
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "delete-app-objects", "delete-app-record"]);

    const logs: string[] = [];
    await runAll(def, logs);
    expect(projects.get("argocd", memberAppProject(GUID, "web", "prod"))).toBeUndefined();
    expect(cluster.admissionPolicies.has(tenantMemberAdmissionPolicyName(GUID, "web", "prod"))).toBe(false);
    expect(vaultDeletes).toEqual([{ stage: "prod", guid: GUID, app: "web" }]);
    expect(appRow("tnt_1", "web")).toBeUndefined();
    // The record stays, marked deleted by whoever ran the purge, and frees the app's name.
    expect(db.sqlite.prepare("SELECT deleted IS NOT NULL AS gone, deleted_by FROM tenant_apps WHERE tenant_id = 'tnt_1' AND name = 'web'").all()).toEqual([{ gone: 1, deleted_by: "op_system" }]);
    db.db.insert(tenantApps).values({ id: "tna_web_again", tenantId: "tnt_1", name: "web" }).run();
    expect(appRow("tnt_1", "web")?.id).toBe("tna_web_again");
    expect(tenantRow("tnt_1")?.lastRunId).toBe("run_purge");
    // The sibling app and the other tenant's app of the same name keep everything.
    expect(appRow("tnt_1", "erp")?.status).toBe("active");
    expect(projects.get("argocd", memberAppProject(GUID, "erp", "prod"))).toBeDefined();
    expect(cluster.admissionPolicies.has(tenantMemberAdmissionPolicyName(GUID, "erp", "prod"))).toBe(true);
    expect(appRow("tnt_2", "web")?.status).toBe("offboarded");
    expect(projects.get("argocd", memberAppProject(OTHER_GUID, "web", "prod"))).toBeDefined();
    expect(cluster.admissionPolicies.has(tenantMemberAdmissionPolicyName(OTHER_GUID, "web", "prod"))).toBe(true);
    expect(tenantRow("tnt_2")?.lastRunId ?? null).toBeNull();
    expect(logs.some((l) => l.includes(`record of app "web"`))).toBe(true);
  });

  it("PLANTED DEFECT: finds and deletes what a move left of the app on the tenant's former cluster, naming that cluster", async () => {
    seedTenants();
    // The tenant moved from s2 to s1 before the fix that clears every app row's objects: web's AppProject
    // and admission policy still stand on s2, and s1 has none.
    db.db.insert(servers).values({ id: "srv_2", name: "m2", host: "1.2.3.5", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", name: "s2", status: "active" }).run();
    const { ports } = await world({ project: false, policy: false });
    const former = new FakeClusterReader({ deployState: { domain: "s2.example", stage: "prod", writtenAt: "x", generation: 1 } });
    former.admissionPolicies.set(tenantMemberAdmissionPolicyName(GUID, "web", "prod"), {} as never);
    const formerProjects = new FakeMasterProjectWriter();
    await formerProjects.applyAppProject("s2", project(GUID, "web"));
    (ports.resolver as FakeClusterKubeResolver).set("cls_2", { clusterReader: former, argoReader: new FakeMasterArgoReader({}), projectWriter: formerProjects, argoNamespace: "s2" });
    const def = makePurgeAppDef(ports);
    const plan = await def.plan(PARAMS, { db: db.db });
    expect(plan.summary).toContain(`AppProject ${memberAppProject(GUID, "web", "prod")} on s2.example`);
    expect(plan.summary).toContain(`admission policy ${tenantMemberAdmissionPolicyName(GUID, "web", "prod")} with its binding on s2.example`);
    expect(plan.summary).toContain(`namespace ${memberNamespace(GUID, "web", "prod")} on s2.example`);
    await runAll(def);
    expect(formerProjects.get("s2", memberAppProject(GUID, "web", "prod"))).toBeUndefined();
    expect(former.deletedAdmissionPolicies).toEqual([tenantMemberAdmissionPolicyName(GUID, "web", "prod")]);
    expect(former.deletedNamespaces).toEqual([memberNamespace(GUID, "web", "prod")]);
    expect(appRow("tnt_1", "web")).toBeUndefined();
  });

  it("PLANTED DEFECT: reads the tenant's own cluster though it is not active, and deletes what stands there", async () => {
    seedTenants();
    db.db.update(clusters).set({ status: "rebuilding" }).where(eq(clusters.id, "cls_1")).run();
    const { ports, projects, cluster } = await world();
    await runAll(makePurgeAppDef(ports));
    expect(projects.get("argocd", memberAppProject(GUID, "web", "prod"))).toBeUndefined();
    expect(cluster.deletedAdmissionPolicies).toEqual([tenantMemberAdmissionPolicyName(GUID, "web", "prod")]);
  });

  it("names a former cluster it cannot read, leaves what may stand there, and purges the rest", async () => {
    seedTenants();
    db.db.insert(servers).values({ id: "srv_2", name: "m2", host: "1.2.3.5", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", name: "s2", status: "active" }).run();
    const { ports, projects } = await world();
    const unreachable = new FakeClusterReader({ deployState: { domain: "s2.example", stage: "prod", writtenAt: "x", generation: 1 } });
    unreachable.readNamespaceAnnotations = async () => { throw new Error("connect ECONNREFUSED"); };
    (ports.resolver as FakeClusterKubeResolver).set("cls_2", { clusterReader: unreachable, argoReader: new FakeMasterArgoReader({}), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "s2" });
    const def = makePurgeAppDef(ports);
    const plan = await def.plan(PARAMS, { db: db.db });
    expect(plan.summary).toContain("not read: s2.example — connect ECONNREFUSED; its AppProject, policy and namespace, if any, stay");
    const logs: string[] = [];
    await runAll(def, logs);
    expect(logs.join("\n")).toContain("not read: s2.example — connect ECONNREFUSED");
    expect(projects.get("argocd", memberAppProject(GUID, "web", "prod"))).toBeUndefined();
    expect(appRow("tnt_1", "web")).toBeUndefined();
  });

  it("PLANTED DEFECT: fails where the tenant's own cluster cannot be read", async () => {
    seedTenants();
    const { ports, cluster } = await world();
    cluster.readNamespaceAnnotations = async () => { throw new Error("connect ECONNREFUSED"); };
    await expect(makePurgeAppDef(ports).plan(PARAMS, { db: db.db })).rejects.toThrow("connect ECONNREFUSED");
  });

  it("names only the record where nothing else of the app stands, and deletes it", async () => {
    seedTenants();
    const { ports } = await world({ project: false, policy: false, vaultKeys: [] });
    const def = makePurgeAppDef(ports);
    expect((await def.plan(PARAMS, { db: db.db } as never)).summary).toContain("nothing else of it stands");
    await runAll(def);
    expect(appRow("tnt_1", "web")).toBeUndefined();
  });

  it("PLANTED DEFECT: deletes the empty member namespace that remove-app left, named in the plan, after the AppProject and policy and before the record", async () => {
    seedTenants();
    const ns = memberNamespace(GUID, "web", "prod");
    const { ports, cluster, projects } = await world({ namespace: true });
    const def = makePurgeAppDef(ports);
    const plan = await def.plan(PARAMS, { db: db.db } as never);
    expect(plan.summary).toContain(`namespace ${ns}`);
    expect(plan.steps.find((s) => s.name === "delete-app-objects")?.title).toContain("namespace");
    const atDelete: { project: boolean; policy: boolean; record: boolean }[] = [];
    const deleteNamespace = cluster.deleteNamespace.bind(cluster);
    cluster.deleteNamespace = async (name) => {
      atDelete.push({
        project: projects.get("argocd", memberAppProject(GUID, "web", "prod")) !== undefined,
        policy: cluster.admissionPolicies.has(tenantMemberAdmissionPolicyName(GUID, "web", "prod")),
        record: appRow("tnt_1", "web") !== undefined,
      });
      return deleteNamespace(name);
    };
    const logs: string[] = [];
    await runAll(def, logs);
    expect(cluster.deletedNamespaces).toEqual([ns]);
    expect(atDelete).toEqual([{ project: false, policy: false, record: true }]);
    expect(logs.join("\n")).toContain(`empty namespace ${ns}`);
    expect(appRow("tnt_1", "web")).toBeUndefined();
  });

  it("PLANTED DEFECT: refuses an app whose namespace still holds a workload of any replica count, naming it, and deletes nothing", async () => {
    seedTenants();
    const ns = memberNamespace(GUID, "web", "prod");
    const { ports, cluster, projects, vaultDeletes } = await world({ workloads: ["web", "worker"] });
    const def = makePurgeAppDef(ports);
    await expect(def.plan(PARAMS, { db: db.db } as never)).rejects.toThrow(`namespace ${ns} holds workload(s) web, worker — remove the app first`);
    await expect(runAll(def)).rejects.toThrow("holds workload(s) web, worker");
    expect(cluster.deletedNamespaces).toEqual([]);
    expect(appRow("tnt_1", "web")).toBeDefined();
    expect(projects.get("argocd", memberAppProject(GUID, "web", "prod"))).toBeDefined();
    expect(vaultDeletes).toEqual([]);
  });

  it("PLANTED DEFECT: refuses an app whose namespace still holds a ServiceClaim, naming it, and deletes nothing", async () => {
    seedTenants();
    const ns = memberNamespace(GUID, "web", "prod");
    const { ports, cluster, projects, vaultDeletes } = await world({ serviceClaims: ["web-mongo"] });
    const def = makePurgeAppDef(ports);
    await expect(def.plan(PARAMS, { db: db.db } as never)).rejects.toThrow(`namespace ${ns} holds ServiceClaim(s) web-mongo — remove the app first`);
    await expect(runAll(def)).rejects.toThrow("holds ServiceClaim(s) web-mongo");
    expect(cluster.deletedNamespaces).toEqual([]);
    expect(appRow("tnt_1", "web")).toBeDefined();
    expect(projects.get("argocd", memberAppProject(GUID, "web", "prod"))).toBeDefined();
    expect(vaultDeletes).toEqual([]);
  });

  it("PLANTED DEFECT: refuses an app that is still deployed, naming its workload and Application, and deletes nothing", async () => {
    seedTenants();
    const { ports, cluster, projects } = await world({ workloads: ["web"], application: true });
    const message = await makePurgeAppDef(ports).plan(PARAMS, { db: db.db } as never).catch((e: Error) => e.message);
    expect(message).toContain(`namespace ${memberNamespace(GUID, "web", "prod")} holds workload(s) web`);
    expect(message).toContain(`ArgoCD Application ${memberApplication(GUID, "web", "prod")}`);
    expect(message).toContain("remove the app first");
    expect(cluster.deletedNamespaces).toEqual([]);
    expect(appRow("tnt_1", "web")).toBeDefined();
    expect(projects.get("argocd", memberAppProject(GUID, "web", "prod"))).toBeDefined();
  });

  it("PLANTED DEFECT: refuses an app whose Application stands though its namespace is empty, and deletes nothing", async () => {
    seedTenants();
    const { ports, cluster, projects } = await world({ namespace: true, application: true });
    const message = await makePurgeAppDef(ports).plan(PARAMS, { db: db.db } as never).catch((e: Error) => e.message);
    expect(message).toContain(`ArgoCD Application ${memberApplication(GUID, "web", "prod")}`);
    expect(message).not.toContain("holds");
    expect(cluster.deletedNamespaces).toEqual([]);
    expect(appRow("tnt_1", "web")).toBeDefined();
    expect(projects.get("argocd", memberAppProject(GUID, "web", "prod"))).toBeDefined();
  });

  it("PLANTED DEFECT: refuses an app the tenant's registration still names, though nothing of it is deployed yet, and deletes nothing", async () => {
    seedTenants();
    const { ports, projects, vaultDeletes } = await world({ registered: true });
    const def = makePurgeAppDef(ports);
    await expect(def.plan(PARAMS, { db: db.db } as never)).rejects.toThrow("the registration still names it");
    await expect(runAll(def)).rejects.toThrow("the registration still names it");
    expect(appRow("tnt_1", "web")).toBeDefined();
    expect(projects.get("argocd", memberAppProject(GUID, "web", "prod"))).toBeDefined();
    expect(vaultDeletes).toEqual([]);
  });

  it.each(["active", "suspended", "provisioning", "purged"] as const)("refuses an app that is %s", async (status) => {
    seedTenants({ webStatus: status });
    const { ports } = await world();
    await expect(makePurgeAppDef(ports).plan(PARAMS, { db: db.db } as never)).rejects.toThrow("only an offboarded app is purged");
    expect(appRow("tnt_1", "web")?.status).toBe(status);
  });

  it.each(["offboarded", "purged", "provisioning"] as const)("refuses the app of a tenant that is %s, whose restore would look for the record", async (status) => {
    seedTenants({ tenantStatus: status });
    const { ports } = await world();
    await expect(makePurgeAppDef(ports).plan(PARAMS, { db: db.db } as never)).rejects.toThrow(`tenant ${GUID} is ${status}`);
    expect(appRow("tnt_1", "web")).toBeDefined();
  });

  it("refuses an app the tenant has no record of", async () => {
    seedTenants();
    const { ports } = await world();
    await expect(makePurgeAppDef(ports).plan({ tenantId: "tnt_1", app: "shop" }, { db: db.db } as never)).rejects.toThrow(`app "shop" of tenant ${GUID}`);
  });

  it.each([
    ["the app came back", () => db.db.update(tenantApps).set({ status: "active" }).where(eq(tenantApps.id, "tna_web")).run(), "only an offboarded app is purged"],
    ["the tenant was offboarded", () => db.db.update(tenants).set({ status: "offboarded" }).where(eq(tenants.id, "tnt_1")).run(), `tenant ${GUID} is offboarded`],
  ] as const)("reads again when it runs, and deletes nothing when %s after the plan", async (_what, change, refusal) => {
    seedTenants();
    const { ports, projects } = await world();
    const def = makePurgeAppDef(ports);
    await def.plan(PARAMS, { db: db.db } as never);
    change();
    await expect(runAll(def)).rejects.toThrow(refusal);
    expect(appRow("tnt_1", "web")).toBeDefined();
    expect(projects.get("argocd", memberAppProject(GUID, "web", "prod"))).toBeDefined();
  });

  it("checks again before it deletes the record, so a run resumed after the tenant changed deletes no record", async () => {
    seedTenants();
    const { ports } = await world();
    const steps = makePurgeAppDef(ports).steps(PARAMS);
    for (const step of steps.slice(0, 2)) await step.run(ctx("run_purge", step.name, []));
    db.db.update(tenantApps).set({ status: "active" }).where(eq(tenantApps.id, "tna_web")).run();
    await expect(steps[2]!.run(ctx("run_purge", steps[2]!.name, []))).rejects.toThrow("only an offboarded app is purged");
    expect(appRow("tnt_1", "web")?.status).toBe("active");
    db.db.update(tenantApps).set({ status: "offboarded" }).where(eq(tenantApps.id, "tna_web")).run();
    db.db.update(tenants).set({ status: "offboarded" }).where(eq(tenants.id, "tnt_1")).run();
    await expect(steps[2]!.run(ctx("run_purge", steps[2]!.name, []))).rejects.toThrow(`tenant ${GUID} is offboarded`);
    expect(appRow("tnt_1", "web")).toBeDefined();
  });

  it("refuses when this Manager cannot read Vault, since a key standing there could not be seen", async () => {
    seedTenants();
    const { ports } = await world();
    delete ports.seeder;
    await expect(makePurgeAppDef(ports).plan(PARAMS, { db: db.db } as never)).rejects.toThrow("Vault");
    expect(appRow("tnt_1", "web")).toBeDefined();
  });
});
