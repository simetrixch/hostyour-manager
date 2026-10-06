import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeRemoveAppDef, tenantWatchSet } from "./tenant-lifecycle.run.ts";
import { makeOffboardTenantDef } from "./tenant-offboard.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { renderTenantAppProject } from "./appproject.ts";
import { loadTenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { memberAppProject, memberApplication } from "./tenant-fanout.ts";
import { FakePlatformRepo, FAKE_BOOKS_BRANCH } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { renderTenantArgoSync } from "#unit/server/build-rbac.ts";
import { ARGO_NS, testMembers } from "./tenant-members.fixture.ts";
import { GUID, DEPLOY_REPO, PLATFORM_REPO, FULL_SET, entry, ports, syncedMap, lifecycleHarness } from "./tenant-lifecycle.fixture.ts";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });
const { ctx, seedTenant, runAll } = lifecycleHarness(() => db);

describe("remove-app run", () => {
  it("drops only the named app, prunes only its Application, and marks the tenant_app offboarded", async () => {
    seedTenant({ apps: ["erp", "web"] });
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ apps: [{ name: "erp", seedReference: false, seedDemo: false, selections: {} }, { name: "web", seedReference: false, seedDemo: false, selections: {} }], members: testMembers([{ name: "erp", seedReference: false, seedDemo: false, selections: {} }, { name: "web", seedReference: false, seedDemo: false, selections: {} }]) }), runId: "run_onb" });

    const logs: string[] = [];
    await runAll(makeRemoveAppDef(ports(reg)).steps({ tenantId: "tnt_1", app: "web" }), "run_rma", { tenantId: "tnt_1", app: "web" }, logs);

    // The registration keeps erp; every sibling member is untouched.
    expect((await reg.readTenant("prod", GUID))?.entry.apps).toEqual([{ name: "erp", seedReference: false, seedDemo: false, selections: {} }]);
    expect(db.db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, "tnt_1"), eq(tenantApps.name, "web"))).get()?.status).toBe("offboarded");
    expect(db.db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, "tnt_1"), eq(tenantApps.name, "erp"))).get()?.status).toBe("active");
    expect(logs.some((l) => l.includes("every sibling member is untouched"))).toBe(true);
  });

  const TWO_APPS = [{ name: "erp", seedReference: false, seedDemo: false, selections: {} }, { name: "web", seedReference: false, seedDemo: false, selections: {} }];
  // The bundle goes with the last app (#217): its build registration goes and the registration is its
  // platform alone again; the repository STANDS (#241). A sibling standing keeps the bundle.
  it("the last app removed takes the tenant's apps build registration and the bundle fields with it, and leaves the repository standing; a sibling standing keeps them", async () => {
    seedTenant({ apps: ["erp", "web"] });
    const reg = new TenantRegistrations(new FakePlatformRepo());
    const bundle = { appsRepo: "https://github.com/acme-org/example-apps-simetrix.git", appsImage: "example-apps-simetrix", appsImageTag: "0.1.0-stable-20260101000000-abc1234" };
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ ...bundle, apps: TWO_APPS, members: testMembers(TWO_APPS) }), runId: "run_onb" });
    const githubApp = new FakeGitHubApp();
    githubApp.org = "acme-org";
    githubApp.seedRepository("acme-org", "example-apps-simetrix");
    const removedUnits: string[] = [];
    const prt = ports(reg, { githubApp, buildRegistrations: { removeBuildRegistration: async (name: string) => { removedUnits.push(name); return { removed: true }; } } as unknown as NonNullable<TenantLifecyclePorts["buildRegistrations"]> });
    const logs: string[] = [];
    await runAll(makeRemoveAppDef(prt).steps({ tenantId: "tnt_1", app: "web" }), "run_rma", { tenantId: "tnt_1", app: "web" }, logs);
    expect(removedUnits).toEqual([]);
    expect((await reg.readTenant("prod", GUID))?.entry.appsRepo).toBe(bundle.appsRepo);
    expect(logs.some((l) => l.includes("still deploys erp — its apps bundle stays registered"))).toBe(true);
    await runAll(makeRemoveAppDef(prt).steps({ tenantId: "tnt_1", app: "erp" }), "run_rma2", { tenantId: "tnt_1", app: "erp" }, logs);
    expect(githubApp.repos.has("acme-org/example-apps-simetrix")).toBe(true); // the repository stands (#241)
    expect(logs.some((l) => l === `repository ${bundle.appsRepo} stands — this Manager deletes no repository (#241); it is the owner's to delete by hand once it is to go`)).toBe(true);
    expect(removedUnits).toEqual(["example-apps-simetrix"]);
    const after = (await reg.readTenant("prod", GUID))?.entry;
    expect(after?.apps).toEqual([]);
    expect(after?.appsRepo).toBeUndefined();
    expect(after?.appsImage).toBe("");
    // A resume finds nothing to delete and nothing to clear.
    await runAll(makeRemoveAppDef(prt).steps({ tenantId: "tnt_1", app: "erp" }), "run_rma3", { tenantId: "tnt_1", app: "erp" }, logs);
    expect(removedUnits).toEqual(["example-apps-simetrix"]);
    expect(logs.some((l) => l.includes("records no apps repository — nothing to take back"))).toBe(true);
  });

  it("takes the registration back without the App, whoever created the repository — nothing on GitHub is touched", async () => {
    seedTenant({ apps: ["erp"] });
    const reg = new TenantRegistrations(new FakePlatformRepo());
    const foreign = { appsRepo: "https://github.com/customer/their-apps.git", appsImage: "their-apps", appsImageTag: "1.0.0" };
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(foreign), runId: "run_onb" });
    const removedUnits: string[] = [];
    const logs: string[] = [];
    await runAll(makeRemoveAppDef(ports(reg, { buildRegistrations: { removeBuildRegistration: async (name: string) => { removedUnits.push(name); return { removed: true }; } } as unknown as NonNullable<TenantLifecyclePorts["buildRegistrations"]> })).steps({ tenantId: "tnt_1", app: "erp" }), "run_rma", { tenantId: "tnt_1", app: "erp" }, logs);
    expect(removedUnits).toEqual(["their-apps"]);
    expect(logs.some((l) => l.includes(`repository ${foreign.appsRepo} stands`))).toBe(true);
    expect((await reg.readTenant("prod", GUID))?.entry.appsImage).toBe("");
  });

  it("plans with the five steps + tenant-remove-app kind", async () => {
    seedTenant({ apps: ["erp", "web"] });
    const plan = await makeRemoveAppDef(ports(new TenantRegistrations(new FakePlatformRepo()))).plan({ tenantId: "tnt_1", app: "web" }, { db: db.db });
    expect(plan.kind).toBe("tenant-remove-app");
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-app-pointer", "watch-prune", "remove-apps-registration", "record-app-removed"]);
  });
});

describe("tenant-offboard run", () => {
  it("plans with tenant targetKind, the five steps, and the tenant locks", async () => {
    seedTenant();
    const def = makeOffboardTenantDef(ports(new TenantRegistrations(new FakePlatformRepo())));
    const plan = await def.plan({ tenantId: "tnt_1" }, { db: db.db });
    expect(def.mutating).toBe(true);
    expect(plan.targetKind).toBe("tenant");
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-apps-registration", "remove-tenant", "watch-removal", "delete-appprojects", "remove-dns", "record-offboard"]);
    expect(plan.locks).toEqual([{ resource: "git-branch", key: `deploy@${FAKE_BOOKS_BRANCH}` }, { resource: "master-kube", key: "m" }]);
  });

  it("removes the registration, waits for the whole fan-out to drain, deletes EVERY member AppProject, and marks the rows offboarded (kept)", async () => {
    seedTenant({ apps: ["erp", "web"] });
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ apps: [{ name: "erp", seedReference: false, seedDemo: false, selections: {} }, { name: "web", seedReference: false, seedDemo: false, selections: {} }], members: testMembers([{ name: "erp", seedReference: false, seedDemo: false, selections: {} }, { name: "web", seedReference: false, seedDemo: false, selections: {} }]) }), runId: "run_onb" });
    const projects = new FakeMasterProjectWriter();
    const members = ["auth", "jobs", "report", "erp", "web"];
    for (const member of members) {
      await projects.applyAppProject(ARGO_NS, renderTenantAppProject({ guid: GUID, member, stage: "prod", argoNamespace: ARGO_NS, deployRepoUrl: DEPLOY_REPO, platformRepoURL: PLATFORM_REPO, cluster: "s1" }));
    }
    for (const member of members) expect(projects.get(ARGO_NS, memberAppProject(GUID, member, "prod"))).toBeDefined();

    const logs: string[] = [];
    await runAll(makeOffboardTenantDef(ports(reg, { projects })).steps({ tenantId: "tnt_1" }), "run_off", { tenantId: "tnt_1" }, logs);

    expect(await reg.readTenant("prod", GUID)).toBeNull(); // registration gone
    // ALL of them — one AppProject left standing would outlive the tenant it fenced.
    for (const member of members) expect(projects.get(ARGO_NS, memberAppProject(GUID, member, "prod"))).toBeUndefined();
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("offboarded"); // soft state — row kept
    expect(row?.lastRunId).toBe("run_off");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.tenantId, "tnt_1")).get()?.status).toBe("offboarded");
  });

  it("removes the pointer of a tenant whose registration is CORRUPT — only ABSENT skips, never unreadable", async () => {
    // remove-tenant asks ONE question — "is this pointer already gone?" — and asking it through
    // the strict readTenant, which THROWS on a body that fails its schema, makes a live tenant whose
    // registration carries a malformed field fail AT THIS STEP, identically on every retry:
    // no removal is ever committed, the pointer stays in the deploy repository and the whole fan-out keeps
    // serving. That would break the one NON-destructive removal run kind — the one api.ts deliberately keeps
    // open on a still-provisioning tenant because it is the clean way OUT — and leave tenant-purge, which
    // deletes the Tenant CR and with it the tenant's Mongo databases and Vault path, as the only way to
    // remove a tenant. The tolerant scan answers "unreadable", which is NOT "absent", so the pointer is
    // git-rm'd BY PATH — all removeTenant needs.
    seedTenant();
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    repo.seed(repo.booksBranch, `registrations/${GUID}/prod.yaml`, 'cluster: "s1"\nsubdomain: 7\n'); // subdomain must be a string
    const remove = makeOffboardTenantDef(ports(reg)).steps({ tenantId: "tnt_1" }).find((s) => s.name === "remove-tenant")!;

    const logs: string[] = [];
    await remove.run(ctx("run_off", "remove-tenant", {}, logs));

    expect(repo.commits.at(-1)?.remove).toEqual([`registrations/${GUID}/prod.yaml`]);
    expect(logs.some((l) => l.includes(`tenant ${GUID} registration removed`))).toBe(true);
    expect(logs.some((l) => l.includes("skipping (resume)"))).toBe(false); // removed, not mistaken for absent
  });

  it("delete-appprojects is idempotent when the projects are already absent", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo());
    const del = makeOffboardTenantDef(ports(reg)).steps({ tenantId: "tnt_1" }).find((s) => s.name === "delete-appprojects")!;
    await del.run(ctx("run_off", "delete-appprojects", {}, []));
    await del.run(ctx("run_off", "delete-appprojects", {}, [])); // second delete does not throw
  });

  it("delete-appprojects also deletes the tenant's argo-sync grant — the inverse of create-tenant's provisioning", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo());
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderTenantArgoSync({ stage: "prod", guid: GUID, applications: [`${GUID}-auth-prod`], argoNamespace: "argocd", units: ["example-platform"] })]);
    const del = makeOffboardTenantDef(ports(reg, { buildRbac })).steps({ tenantId: "tnt_1" }).find((s) => s.name === "delete-appprojects")!;
    await del.run(ctx("run_off", "delete-appprojects", {}, []));
    expect(buildRbac.keys()).toEqual([]);
  });

  it("watch-removal fails when the fan-out never prunes", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    argo.setStatuses(syncedMap(FULL_SET)); // still Synced ⇒ not pruned
    const steps = makeOffboardTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" });
    await steps[0]!.run(ctx("run_off", "attest-target", {}, []));
    await steps[1]!.run(ctx("run_off", "remove-apps-registration", {}, []));
    await steps[2]!.run(ctx("run_off", "remove-tenant", {}, []));
    await expect(steps[3]!.run(ctx("run_off", "watch-removal", {}, []))).rejects.toThrow(/was not pruned/);
  });

  it("watch-removal covers EVERY member — one lingering trio member fails the offboard", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    // Everything pruned EXCEPT the auth member. No member survives an offboard, so this must fail rather
    // than record the tenant removed while its identity provider keeps serving.
    argo.setStatuses(syncedMap([memberApplication(GUID, "auth", "prod")]));
    const steps = makeOffboardTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" });
    await steps[0]!.run(ctx("run_off", "attest-target", {}, []));
    await steps[1]!.run(ctx("run_off", "remove-apps-registration", {}, []));
    await steps[2]!.run(ctx("run_off", "remove-tenant", {}, []));
    await expect(steps[3]!.run(ctx("run_off", "watch-removal", {}, []))).rejects.toThrow(/was not pruned/);
  });

  it("attest-target fails closed on a deploy-state domain mismatch", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo());
    const prt = ports(reg, { cluster: new FakeClusterReader({ deployState: { domain: "other.example", stage: "prod", writtenAt: "x", generation: 1 } }) });
    const attest = makeOffboardTenantDef(prt).steps({ tenantId: "tnt_1" })[0]!;
    await expect(attest.run(ctx("run_off", "attest-target", {}, []))).rejects.toThrow(/deploy-state mismatch/);
  });

  it("record-offboard REFUSES TO DOWNGRADE a tenant a purge already settled", async () => {
    // The same "offboarded"-over-"purged" downgrade as the shared teardown's record step, at this run's own
    // copy of the write — and reachable without any UI at all: POST /api/tenants/:id/offboard takes any
    // row id and checks NO status (api.ts TENANT_LIFECYCLE — offboard deliberately refuses nothing,
    // because it is the way OUT of "provisioning"), so a tenant-offboard can be planned and approved on a
    // deprovisioned tenant. Every step ahead of this one then no-ops: the pointer is gone (remove-tenant
    // skips), the fan-out is pruned (watch-removal passes over Missing names), the AppProject is already
    // absent. Only the record step would have written anything — "offboarded" over "purged", with this
    // run's id — which un-does a completed purge in the inventory and puts the tenant back on the
    // "Offboarded tenants" panel offering the removal that already ran.
    seedTenant({ status: "purged", appStatus: "purged", apps: ["erp", "web"] });
    db.db.update(tenants).set({ lastRunId: "run_tpurge" }).where(eq(tenants.id, "tnt_1")).run();
    const rec = makeOffboardTenantDef(ports(new TenantRegistrations(new FakePlatformRepo()))).steps({ tenantId: "tnt_1" }).find((s) => s.name === "record-offboard")!;

    const logs: string[] = [];
    await rec.run(ctx("run_off", "record-offboard", {}, logs));

    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("purged");
    expect(row?.lastRunId).toBe("run_tpurge"); // the run that DID remove the tenant keeps the row
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.tenantId, "tnt_1")).all().map((a) => a.status)).toEqual(["purged", "purged"]);
    expect(logs.some((l) => l.includes(`tenant ${GUID} is already recorded purged`))).toBe(true);
    expect(logs.some((l) => l.includes("recorded as offboarded"))).toBe(false);
  });
});

// create-tenant records the tenant AND its app rows BEFORE it deploys, so a
// half-created tenant's rows sit at "provisioning" while the appset has long generated their
// Applications. Every projection of the fan-out therefore filters "everything except offboarded", never
// "active" — these two tests pin what the old filter would have cost.
describe("a still-provisioning tenant offboards COMPLETELY", () => {
  const twoApps = [{ name: "erp", seedReference: false, seedDemo: false, selections: {} }, { name: "web", seedReference: false, seedDemo: false, selections: {} }];

  it("its watch set counts the provisioning app rows — an \"active\" filter would report a false success", async () => {
    seedTenant({ status: "provisioning", appStatus: "provisioning", apps: ["erp", "web"] });
    const names = tenantWatchSet(db.db, loadTenantCluster(db.db, "tnt_1"));
    for (const n of [memberApplication(GUID, "erp", "prod"), memberApplication(GUID, "web", "prod")]) expect(names).toContain(n);

    // The behaviour that depends on it: with "web" dropped from the set, allPruned would pass over the
    // remaining names and offboard would declare the tenant pruned while web's Applications kept running.
    const reg = new TenantRegistrations(new FakePlatformRepo());
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ apps: twoApps, members: testMembers(twoApps) }), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    argo.setStatuses(syncedMap([memberApplication(GUID, "web", "prod")])); // everything pruned EXCEPT web
    const steps = makeOffboardTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" });
    await steps[0]!.run(ctx("run_off", "attest-target", {}, []));
    await steps[1]!.run(ctx("run_off", "remove-apps-registration", {}, []));
    await steps[2]!.run(ctx("run_off", "remove-tenant", {}, []));
    await expect(steps[3]!.run(ctx("run_off", "watch-removal", {}, []))).rejects.toThrow(/was not pruned/);
  });

  it("a PURGED app row is out of the watch set — settled is settled, whichever removal settled it", () => {
    // "purged" is the second terminal status, and every projection of the fan-out that
    // spelled its filter `!== "offboarded"` would have kept a purged app row IN: the watch would then wait
    // on an Application ArgoCD deleted with the tenant's namespace and can never re-create, i.e. it would
    // hang until the budget expired and then report the fan-out unpruned. The filter asks the shared
    // TENANT_SETTLED_STATUS set instead, so both terminal states drop out together.
    seedTenant({ appStatus: "purged", apps: ["erp", "web"] });
    const names = tenantWatchSet(db.db, loadTenantCluster(db.db, "tnt_1"));
    for (const n of [memberApplication(GUID, "erp", "prod"), memberApplication(GUID, "web", "prod")]) expect(names).not.toContain(n);
    expect(names).toContain(memberApplication(GUID, "auth", "prod")); // the mandatory trio is untouched by it
  });

  it("record-offboard flips its provisioning app rows too — none is left claiming a state it no longer has", async () => {
    seedTenant({ status: "provisioning", appStatus: "provisioning", apps: ["erp", "web"] });
    const rec = makeOffboardTenantDef(ports(new TenantRegistrations(new FakePlatformRepo()))).steps({ tenantId: "tnt_1" }).find((s) => s.name === "record-offboard")!;
    await rec.run(ctx("run_off", "record-offboard", {}, []));
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("offboarded");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.tenantId, "tnt_1")).all().map((a) => a.status)).toEqual(["offboarded", "offboarded"]);
  });
});
