import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeDeleteAppRecordDef } from "./tenant-delete-app-record.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { fakeTenantSeeder } from "./tenant-seeder.fixture.ts";
import { renderTenantAppProject } from "./appproject.ts";
import { memberAppProject, memberApplication, memberNamespace } from "./tenant-fanout.ts";
import { tenantMemberAdmissionPolicyName } from "./admission-policy.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TenantStatus } from "../../../shared/enums.ts";

// tenant-delete-app-record: the record of an app a remove-app took off a standing tenant is deleted by
// hand, once the Manager has read that nothing of the app remains: no namespace on the tenant's
// cluster, no ArgoCD Application or AppProject, no admission policy, no Vault key. A live app is
// refused, and so is one of which anything still stands, each piece named.

const GUID = "zsjs023ctne0";
const PARAMS = { tenantId: "tnt_1", app: "web" };

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function seedTenant(webStatus: TenantStatus = "offboarded"): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({
    id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "simetrix", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", routing: "host", ownDomain: "", ownDomainRedirects: [], approvedTags: {},
    suspended: false, status: "active",
  }).run();
  db.db.insert(tenantApps).values({ id: "tna_erp", tenantId: "tnt_1", name: "erp", status: "active" }).run();
  db.db.insert(tenantApps).values({ id: "tna_web", tenantId: "tnt_1", name: "web", status: webStatus }).run();
}

/** The cluster, master and Vault as a remove-app leaves them: every piece of `web` gone, unless a
 *  test puts one back. */
function world(left: { namespace?: boolean; application?: boolean; project?: boolean; policy?: boolean; vaultKeys?: string[] } = {}) {
  const namespace = memberNamespace(GUID, "web", "prod");
  const cluster = new FakeClusterReader({
    deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 },
    absentNamespaces: left.namespace ? [] : [namespace],
  });
  if (left.policy) cluster.admissionPolicies.set(tenantMemberAdmissionPolicyName(GUID, "web", "prod"), {} as never);
  const argo = new FakeMasterArgoReader(left.application ? { status: { syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy" } } : {});
  const projects = new FakeMasterProjectWriter();
  if (left.project) {
    void projects.applyAppProject("argocd", renderTenantAppProject({
      guid: GUID, member: "web", stage: "prod", argoNamespace: "argocd", deployRepoUrl: "https://github.com/acme/acme-deploy.git",
      platformRepoURL: "https://github.com/simetrixch/hostyour-cloud.git", cluster: "s1",
    }));
  }
  const listed: Array<{ stage: string; guid: string; app: string }> = [];
  const seeder = { ...fakeTenantSeeder(), listTenantAppKeys: async (input: { stage: string; guid: string; app: string }) => { listed.push(input); return left.vaultKeys ?? []; } };
  const ports: TenantLifecyclePorts = {
    registrations: new TenantRegistrations(new FakePlatformRepo()),
    resolver: new FakeClusterKubeResolver({ clusterReader: cluster, argoReader: argo, projectWriter: projects, argoNamespace: "argocd" }),
    deployRepoUrl: "https://github.com/acme/acme-deploy.git",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    seeder,
  };
  return { ports, cluster, listed };
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

const appRow = (name: string) => db.db.select().from(tenantApps).where(eq(tenantApps.name, name)).get();

describe("tenant-delete-app-record run", () => {
  it("PLANTED DEFECT: refuses an offboarded app of which anything still stands, and names every piece", async () => {
    seedTenant();
    const { ports } = world({ namespace: true, application: true, project: true, policy: true, vaultKeys: ["service-key/web", "password-field-key/web"] });
    const plan = makeDeleteAppRecordDef(ports).plan(PARAMS, { db: db.db } as never);
    await expect(plan).rejects.toThrow(`namespace ${memberNamespace(GUID, "web", "prod")}`);
    const message = await plan.catch((e: Error) => e.message);
    for (const piece of [
      `ArgoCD Application ${memberApplication(GUID, "web", "prod")}`,
      `AppProject ${memberAppProject(GUID, "web", "prod")}`,
      `admission policy ${tenantMemberAdmissionPolicyName(GUID, "web", "prod")}`,
      `Vault key prod/tenants/${GUID}/service-key/web`,
      `Vault key prod/tenants/${GUID}/password-field-key/web`,
    ]) expect(message).toContain(piece);
    expect(appRow("web")).toBeDefined();
  });

  it("deletes the record of an offboarded app of which nothing remains, and leaves every sibling and the tenant standing", async () => {
    seedTenant();
    const { ports, listed } = world();
    const def = makeDeleteAppRecordDef(ports);
    const plan = await def.plan(PARAMS, { db: db.db } as never);
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "delete-app-record"]);
    expect(plan.summary).toContain(`"web"`);
    expect(listed).toEqual([{ stage: "prod", guid: GUID, app: "web" }]);
    const logs: string[] = [];
    for (const step of def.steps(PARAMS)) await step.run(ctx("run_del", step.name, logs));
    expect(appRow("web")).toBeUndefined();
    expect(appRow("erp")?.status).toBe("active");
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.lastRunId).toBe("run_del");
    expect(logs.some((l) => l.includes(`record of app "web"`))).toBe(true);
  });

  it.each(["active", "suspended", "provisioning", "purged"] as const)("refuses an app that is %s, and deletes nothing", async (status) => {
    seedTenant(status);
    const { ports } = world();
    await expect(makeDeleteAppRecordDef(ports).plan(PARAMS, { db: db.db } as never)).rejects.toThrow("only an offboarded app's record is deleted");
    expect(appRow("web")?.status).toBe(status);
  });

  it("refuses an app the tenant has no record of", async () => {
    seedTenant();
    const { ports } = world();
    await expect(makeDeleteAppRecordDef(ports).plan({ tenantId: "tnt_1", app: "shop" }, { db: db.db } as never)).rejects.toThrow(`app "shop" of tenant ${GUID}`);
  });

  it("reads again when it runs, and keeps the record when a piece came back after the plan", async () => {
    seedTenant();
    const { ports, cluster } = world();
    const def = makeDeleteAppRecordDef(ports);
    await def.plan(PARAMS, { db: db.db } as never);
    cluster.admissionPolicies.set(tenantMemberAdmissionPolicyName(GUID, "web", "prod"), {} as never);
    const steps = def.steps(PARAMS);
    await steps[0]!.run(ctx("run_del", steps[0]!.name, []));
    await expect(steps[1]!.run(ctx("run_del", steps[1]!.name, []))).rejects.toThrow("admission policy");
    expect(appRow("web")?.status).toBe("offboarded");
  });

  it("refuses when this Manager cannot read Vault, since a key standing there could not be seen", async () => {
    seedTenant();
    const { ports } = world();
    delete ports.seeder;
    await expect(makeDeleteAppRecordDef(ports).plan(PARAMS, { db: db.db } as never)).rejects.toThrow("Vault");
    expect(appRow("web")).toBeDefined();
  });
});
