import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq, and } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeSuspendTenantDef, makeResumeTenantDef, makeRemoveAppDef, tenantWatchMembers, tenantWatchSet } from "./tenant-lifecycle.run.ts";
import { makeOffboardTenantDef } from "./tenant-offboard.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { renderTenantAppProject } from "./appproject.ts";
import { loadTenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { memberAppProject, memberApplication, memberNamespace, tenantApplicationSet } from "./tenant-fanout.ts";
import { FakePlatformRepo, FAKE_BOOKS_BRANCH } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { renderTenantArgoSync } from "./build-rbac.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import type { TenantStatus } from "../../../shared/enums.ts";
import { ARGO_NS, STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";


const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0"; // a live guid (matches the registrations/** path guard)
const DEPLOY_REPO = "https://github.com/acme/acme-catalog.git";
const PLATFORM_REPO = "https://github.com/simetrixch/hostyour-cloud.git";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

/** A cluster-marking resolver that answers from a literal name -> stage map — mirrors registrations.test.ts's
 *  helper. Every registration this file commits targets "s1" at "prod". */
function marked(byName: Record<string, Stage>): ClusterStageResolver {
  return async (cluster: string) => {
    const stage = byName[cluster];
    if (!stage) throw new Error(`no cluster map for "${cluster}"`);
    return { name: cluster, stage };
  };
}
const CLUSTERS = marked({ s1: "prod" });

// The registration carries no trio block of any kind: auth, jobs and report are members of EVERY
// tenant, so there is nothing to state and nothing to gate.
function entry(over: Partial<TenantRegistration> = {}): TenantRegistration {
  return {
    cluster: "s1",
    members: testMembers([{ name: "erp", seedReference: false, seedDemo: false }]),
    identityProvider: "auth",
    subdomain: "simetrix.dev",
    apps: [{ name: "erp", seedReference: false, seedDemo: false }],
    seedUsers: false, quota: seedQuota("small"),
    resetNonce: "1",
    suspended: false,
    quiesced: false,
    ...over,
  };
}

// The kube clients ride behind the resolver now: fold the per-test fakes (argo/cluster/
// projects) into a FakeClusterKubeResolver whose master path resolves to argoNamespace "argocd".
type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

function ports(reg: TenantRegistrations, over: Partial<TenantLifecyclePorts> & FakeKube = {}): TenantLifecyclePorts {
  const { argo, cluster, projects, ...portOver } = over;
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } }),
      argoReader: argo ?? new FakeMasterArgoReader(),
      projectWriter: projects ?? new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_REPO,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    dns: new FakeDnsProvider(),
    ...portOver,
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

// `appStatus` is separate from `status` on purpose: a tenant_apps row carries its OWN lifecycle state,
// and the watch-set filter is keyed on it — so a test has to be able to set the two independently.
function seedTenant(opts: { status?: TenantStatus; appStatus?: TenantStatus; suspended?: boolean; apps?: string[] } = {}): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(tenants).values({
    id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "simetrix.dev", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth",
    suspended: opts.suspended ?? false, status: opts.status ?? "active",
  }).run();
  for (const name of opts.apps ?? ["erp"]) db.db.insert(tenantApps).values({ id: `tna_${name}`, tenantId: "tnt_1", name, status: opts.appStatus ?? "active" }).run();
}

/** The scripted per-name statuses a converged (Synced/Healthy@SHA) fan-out reports. */
function syncedMap(names: readonly string[], sha = SHA): Map<string, ArgoAppStatus> {
  const m = new Map<string, ArgoAppStatus>();
  for (const n of names) m.set(n, { syncRevision: sha, targetRevision: null, sync: "Synced", health: "Healthy" });
  return m;
}

// The full fan-out for the default seed (the trio + erp), computed via the SAME pure algebra the runs
// use — never hand-rolled (a drifting name hangs the watch forever).
const FULL_SET = tenantApplicationSet([...TEST_MEMBERS, "erp"], GUID, "prod");

/** A smoke answer with ONE workload asking for `desired` replicas — the fake returns it for every
 *  namespace, which is what lets a test say "this tenant is still running" or "this tenant is off". */
function smokeWith(desired: number) {
  return {
    namespaceExists: true,
    workloads: [{ kind: "Deployment", name: "example-auth-backend", available: true, desired, ready: desired }],
    externalSecretsReady: true,
  };
}

/** A cluster reader whose deploy-state attests and whose smoke reports the given replica count. */
function readerRunning(desired: number): FakeClusterReader {
  return new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 }, smoke: smokeWith(desired) });
}

async function runAll(steps: Step[], runId: string, params: Record<string, unknown>, logs: string[]): Promise<void> {
  for (const step of steps) await step.run(ctx(runId, step.name, params, logs));
}

describe("tenant-suspend run", () => {
  it("flips the registration to suspended, waits for every member to converge OFF, and marks the row suspended", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    // Every member Application STAYS Synced/Healthy through a suspend — what changes is what it renders.
    argo.setStatuses(syncedMap(FULL_SET));

    const logs: string[] = [];
    await runAll(makeSuspendTenantDef(ports(reg, { argo, cluster: readerRunning(0) })).steps({ tenantId: "tnt_1" }), "run_susp", { tenantId: "tnt_1" }, logs);

    expect((await reg.readTenant("prod", GUID))?.entry.suspended).toBe(true);
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("suspended");
    expect(row?.suspended).toBe(true);
    expect(logs.some((l) => l.includes("zero replicas"))).toBe(true);
  });

  it("NEVER waits for a prune: a fan-out that went Missing is a suspend that destroyed something", async () => {
    // A prune deletes the member charts' ServiceClaims, whose deprovision finalizer drops the user AND
    // the databases on ANY claim deletion. So a suspend that observed Missing must FAIL, not succeed —
    // the exact inverse of what the old prune-watch asserted.
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const argo = new FakeMasterArgoReader(); // no scripted statuses ⇒ every member reads Missing
    const steps = makeSuspendTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" });
    await steps[0]!.run(ctx("run_susp", "attest-target", {}, []));
    await steps[1]!.run(ctx("run_susp", "suspend-tenant", {}, []));
    await expect(steps[2]!.run(ctx("run_susp", "watch-off", {}, []))).rejects.toThrow(/did not converge on its off state/);
  });

  it("verify-off refuses a tenant that is FLAGGED suspended but still runs replicas", async () => {
    // Synced/Healthy proves ArgoCD applied the manifests, not that the manifests carry the off state.
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    argo.setStatuses(syncedMap(FULL_SET));
    const steps = makeSuspendTenantDef(ports(reg, { argo, cluster: readerRunning(2) })).steps({ tenantId: "tnt_1" });
    for (const name of ["attest-target", "suspend-tenant", "watch-off"]) {
      await steps.find((s) => s.name === name)!.run(ctx("run_susp", name, {}, []));
    }
    const verify = steps.find((s) => s.name === "verify-off")!;
    await expect(verify.run(ctx("run_susp", "verify-off", {}, []))).rejects.toThrow(/still runs Deployment\/example-auth-backend \(2\/2\)/);
    // The row is untouched: the run failed at its measurement, so nothing claims the tenant is off.
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("active");
  });

  it("verify-off refuses a MISSING member namespace — a suspend switches off, it never removes one", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const cluster = new FakeClusterReader({
      deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 },
      smoke: { namespaceExists: false, workloads: [], externalSecretsReady: true },
    });
    const verify = makeSuspendTenantDef(ports(reg, { cluster })).steps({ tenantId: "tnt_1" }).find((s) => s.name === "verify-off")!;
    await expect(verify.run(ctx("run_susp", "verify-off", {}, []))).rejects.toThrow(/does not exist/);
  });

  it("measures EVERY member namespace, one per member — never just one", async () => {
    seedTenant({ apps: ["erp", "web"] });
    expect(tenantWatchMembers(db.db, "tnt_1").map((m) => memberNamespace(GUID, m))).toEqual([
      "zsjs023ctne0-auth",
      "zsjs023ctne0-jobs",
      "zsjs023ctne0-report",
      "zsjs023ctne0-erp",
      "zsjs023ctne0-web",
    ]);
  });

  it("plans with tenant targetKind, the five steps, and the repo-qualified git-branch + master-kube locks", async () => {
    seedTenant();
    const plan = await makeSuspendTenantDef(ports(new TenantRegistrations(new FakePlatformRepo(), CLUSTERS))).plan({ tenantId: "tnt_1" }, { db: db.db });
    expect(plan.targetKind).toBe("tenant");
    expect(plan.targetId).toBe("tnt_1");
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "suspend-tenant", "watch-off", "verify-off", "record-suspended"]);
    expect(plan.locks).toEqual([{ resource: "git-branch", key: `catalog@${FAKE_BOOKS_BRANCH}` }, { resource: "master-kube", key: "m" }]);
    expect(plan.requiredSecrets).toEqual([]);
    // The summary says plainly what survives, because a suspend that read as a prune is what makes an
    // operator expect their data gone.
    expect(plan.summary).toContain("prunes nothing");
  });
});

describe("tenant-resume run", () => {
  it("flips the registration back to active, waits for the fan-out to re-sync at the pin, and marks the row active", async () => {
    seedTenant({ status: "suspended", suspended: true });
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ suspended: true }), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    argo.setStatuses(syncedMap(FULL_SET));

    const logs: string[] = [];
    await runAll(makeResumeTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" }), "run_res", { tenantId: "tnt_1" }, logs);

    expect((await reg.readTenant("prod", GUID))?.entry.suspended).toBe(false);
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("active");
    expect(row?.suspended).toBe(false);
    expect(logs.some((l) => l.includes("live again"))).toBe(true);
  });

  it("resume fails when ArgoCD never re-syncs the whole set at the pin", async () => {
    seedTenant({ status: "suspended", suspended: true });
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ suspended: true }), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    // The auth member is Synced but the rest read Missing ⇒ the set never fully converges.
    argo.setStatuses(new Map<string, ArgoAppStatus>([[FULL_SET[0]!, { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" }]]));
    const steps = makeResumeTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" });
    await steps[0]!.run(ctx("run_res", "attest-target", {}, []));
    await steps[1]!.run(ctx("run_res", "resume-tenant", {}, []));
    await expect(steps[2]!.run(ctx("run_res", "watch-sync", {}, []))).rejects.toThrow(/did not reach Synced/);
  });
});

describe("remove-app run", () => {
  it("drops only the named app, prunes only its Application, and marks the tenant_app offboarded", async () => {
    seedTenant({ apps: ["erp", "web"] });
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ apps: [{ name: "erp", seedReference: false, seedDemo: false }, { name: "web", seedReference: false, seedDemo: false }], members: testMembers([{ name: "erp", seedReference: false, seedDemo: false }, { name: "web", seedReference: false, seedDemo: false }]) }), runId: "run_onb" });

    const logs: string[] = [];
    await runAll(makeRemoveAppDef(ports(reg)).steps({ tenantId: "tnt_1", app: "web" }), "run_rma", { tenantId: "tnt_1", app: "web" }, logs);

    // The registration keeps erp; every sibling member is untouched.
    expect((await reg.readTenant("prod", GUID))?.entry.apps).toEqual([{ name: "erp", seedReference: false, seedDemo: false }]);
    expect(db.db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, "tnt_1"), eq(tenantApps.name, "web"))).get()?.status).toBe("offboarded");
    expect(db.db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, "tnt_1"), eq(tenantApps.name, "erp"))).get()?.status).toBe("active");
    expect(logs.some((l) => l.includes("every sibling member is untouched"))).toBe(true);
  });

  it("plans with the four steps + tenant-remove-app kind", async () => {
    seedTenant({ apps: ["erp", "web"] });
    const plan = await makeRemoveAppDef(ports(new TenantRegistrations(new FakePlatformRepo(), CLUSTERS))).plan({ tenantId: "tnt_1", app: "web" }, { db: db.db });
    expect(plan.kind).toBe("tenant-remove-app");
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-app-pointer", "watch-prune", "record-app-removed"]);
  });
});

describe("tenant-offboard run", () => {
  it("plans with tenant targetKind, the five steps, and the tenant locks", async () => {
    seedTenant();
    const def = makeOffboardTenantDef(ports(new TenantRegistrations(new FakePlatformRepo(), CLUSTERS)));
    const plan = await def.plan({ tenantId: "tnt_1" }, { db: db.db });
    expect(def.mutating).toBe(true);
    expect(plan.targetKind).toBe("tenant");
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-tenant", "watch-removal", "delete-appprojects", "remove-dns", "record-offboard"]);
    expect(plan.locks).toEqual([{ resource: "git-branch", key: `catalog@${FAKE_BOOKS_BRANCH}` }, { resource: "master-kube", key: "m" }]);
  });

  it("removes the registration, waits for the whole fan-out to drain, deletes EVERY member AppProject, and marks the rows offboarded (kept)", async () => {
    seedTenant({ apps: ["erp", "web"] });
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ apps: [{ name: "erp", seedReference: false, seedDemo: false }, { name: "web", seedReference: false, seedDemo: false }], members: testMembers([{ name: "erp", seedReference: false, seedDemo: false }, { name: "web", seedReference: false, seedDemo: false }]) }), runId: "run_onb" });
    const projects = new FakeMasterProjectWriter();
    const members = ["auth", "jobs", "report", "erp", "web"];
    for (const member of members) {
      await projects.applyAppProject(ARGO_NS, renderTenantAppProject({ guid: GUID, member, argoNamespace: ARGO_NS, catalogRepoUrl: DEPLOY_REPO, platformRepoURL: PLATFORM_REPO, cluster: "s1" }));
    }
    for (const member of members) expect(projects.get(ARGO_NS, memberAppProject(GUID, member))).toBeDefined();

    const logs: string[] = [];
    await runAll(makeOffboardTenantDef(ports(reg, { projects })).steps({ tenantId: "tnt_1" }), "run_off", { tenantId: "tnt_1" }, logs);

    expect(await reg.readTenant("prod", GUID)).toBeNull(); // registration gone
    // ALL of them — one AppProject left standing would outlive the tenant it fenced.
    for (const member of members) expect(projects.get(ARGO_NS, memberAppProject(GUID, member))).toBeUndefined();
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("offboarded"); // soft state — row kept
    expect(row?.lastRunId).toBe("run_off");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.tenantId, "tnt_1")).get()?.status).toBe("offboarded");
  });

  it("removes the pointer of a tenant whose registration is CORRUPT — only ABSENT skips, never unreadable", async () => {
    // remove-tenant asks ONE question — "is this pointer already gone?" — and it used to ask it through
    // the strict readTenant, which THROWS on a body that fails its schema. A live tenant whose
    // registration carries a malformed field therefore failed AT THIS STEP, identically on every retry:
    // no removal was ever committed, the pointer stayed in catalog and the whole fan-out kept
    // serving. That would break the one NON-destructive removal run kind — the one api.ts deliberately keeps
    // open on a still-provisioning tenant because it is the clean way OUT — and leave tenant-purge, which
    // deletes the Tenant CR and with it the tenant's Mongo databases and Vault path, as the only way to
    // remove a tenant. The tolerant scan answers "unreadable", which is NOT "absent", so the pointer is
    // git-rm'd BY PATH — all removeTenant needs.
    seedTenant();
    const repo = new FakePlatformRepo();
    const reg = new TenantRegistrations(repo, CLUSTERS);
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
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    const del = makeOffboardTenantDef(ports(reg)).steps({ tenantId: "tnt_1" }).find((s) => s.name === "delete-appprojects")!;
    await del.run(ctx("run_off", "delete-appprojects", {}, []));
    await del.run(ctx("run_off", "delete-appprojects", {}, [])); // second delete does not throw
  });

  it("delete-appprojects also deletes the tenant's argo-sync grant — the inverse of create-tenant's provisioning", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderTenantArgoSync({ guid: GUID, applications: [`${GUID}-auth-prod`], argoNamespace: "argocd", units: ["example-platform"] })]);
    const del = makeOffboardTenantDef(ports(reg, { buildRbac })).steps({ tenantId: "tnt_1" }).find((s) => s.name === "delete-appprojects")!;
    await del.run(ctx("run_off", "delete-appprojects", {}, []));
    expect(buildRbac.keys()).toEqual([]);
  });

  it("watch-removal fails when the fan-out never prunes", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    argo.setStatuses(syncedMap(FULL_SET)); // still Synced ⇒ not pruned
    const steps = makeOffboardTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" });
    await steps[0]!.run(ctx("run_off", "attest-target", {}, []));
    await steps[1]!.run(ctx("run_off", "remove-tenant", {}, []));
    await expect(steps[2]!.run(ctx("run_off", "watch-removal", {}, []))).rejects.toThrow(/was not pruned/);
  });

  it("watch-removal covers EVERY member — one lingering trio member fails the offboard", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    // Everything pruned EXCEPT the auth member. No member survives an offboard, so this must fail rather
    // than record the tenant removed while its identity provider keeps serving.
    argo.setStatuses(syncedMap([memberApplication(GUID, "auth", "prod")]));
    const steps = makeOffboardTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" });
    await steps[0]!.run(ctx("run_off", "attest-target", {}, []));
    await steps[1]!.run(ctx("run_off", "remove-tenant", {}, []));
    await expect(steps[2]!.run(ctx("run_off", "watch-removal", {}, []))).rejects.toThrow(/was not pruned/);
  });

  it("attest-target fails closed on a deploy-state domain mismatch", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
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
    const rec = makeOffboardTenantDef(ports(new TenantRegistrations(new FakePlatformRepo(), CLUSTERS))).steps({ tenantId: "tnt_1" }).find((s) => s.name === "record-offboard")!;

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
  const twoApps = [{ name: "erp", seedReference: false, seedDemo: false }, { name: "web", seedReference: false, seedDemo: false }];

  it("its watch set counts the provisioning app rows — an \"active\" filter would report a false success", async () => {
    seedTenant({ status: "provisioning", appStatus: "provisioning", apps: ["erp", "web"] });
    const names = tenantWatchSet(db.db, loadTenantCluster(db.db, "tnt_1"));
    for (const n of [memberApplication(GUID, "erp", "prod"), memberApplication(GUID, "web", "prod")]) expect(names).toContain(n);

    // The behaviour that depends on it: with "web" dropped from the set, allPruned would pass over the
    // remaining names and offboard would declare the tenant pruned while web's Applications kept running.
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry({ apps: twoApps, members: testMembers(twoApps) }), runId: "run_onb" });
    const argo = new FakeMasterArgoReader();
    argo.setStatuses(syncedMap([memberApplication(GUID, "web", "prod")])); // everything pruned EXCEPT web
    const steps = makeOffboardTenantDef(ports(reg, { argo })).steps({ tenantId: "tnt_1" });
    await steps[0]!.run(ctx("run_off", "attest-target", {}, []));
    await steps[1]!.run(ctx("run_off", "remove-tenant", {}, []));
    await expect(steps[2]!.run(ctx("run_off", "watch-removal", {}, []))).rejects.toThrow(/was not pruned/);
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
    const rec = makeOffboardTenantDef(ports(new TenantRegistrations(new FakePlatformRepo(), CLUSTERS))).steps({ tenantId: "tnt_1" }).find((s) => s.name === "record-offboard")!;
    await rec.run(ctx("run_off", "record-offboard", {}, []));
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("offboarded");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.tenantId, "tnt_1")).all().map((a) => a.status)).toEqual(["offboarded", "offboarded"]);
  });
});
