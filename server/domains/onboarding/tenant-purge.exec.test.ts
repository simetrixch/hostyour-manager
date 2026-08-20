// The EXECUTION half of tenant-purge — what the run does against a cluster: the orphan cases the
// run kind exists for, the belt that refuses an uninventoried tenant whose workloads still RUN, the
// namespace reap and what it can prove, and the row settlement. The PLAN half is
// tenant-purge.run.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeTenantPurgeDef, PURGE_TEARDOWN, type TenantPurgeParams, type TenantPurgeRequest } from "./tenant-purge.run.ts";
import { makeOffboardTenantDef } from "./offboard-tenant.run.ts";
import { TenantRegistry } from "./tenant-registry.ts";
import type { ClusterStageResolver } from "./registry.ts";
import { renderTenantAppProject } from "./appproject.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import { memberAppProject, memberNamespace, tenantApplicationSet } from "./tenant-fanout.ts";
import { CLAIM_RELOCATING_ANNOTATION } from "../../adapters/kube/port.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { PlanStreamCtx, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Stage, TenantStatus } from "../../../shared/enums.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import { ARGO_NS, STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";
import type { VaultSeeder, VaultSeedOutcome, TenantCryptoDeleteInput } from "../../adapters/vault/seeder-port.ts";


// tenant-purge (force-offboard by GUID) tests — the tenant twin of
// purge.run.test.ts, over the same in-memory DB + fake git/kube clients the rest of the tenant family
// uses. The load-bearing NEW properties tenant-purge must have and tenant-offboard does not: it reaps a
// tenant from guid+stage+cluster ALONE (no tenants row — the orphaned partial create-tenant), it is
// FAIL-SOFT (a fan-out that never prunes does not stop the run), it deletes the Tenant CR (the operator
// deprovision cascade) and the namespace, and it is idempotent (a re-run is a no-op).

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const SUB = "acme.example";
const DEPLOY_REPO = "https://github.com/simetrixch/catalog.git";
const PLATFORM_REPO = "https://github.com/simetrixch/hostyour-cloud.git";
const APPS = [{ name: "erp" }];
const WATCH = tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], GUID, "prod");
// The tenant's members — the trio plus its one app. Every one has a namespace and an AppProject of
// its own, so the purge reaps this many of each.
const MEMBERS = [...TEST_MEMBERS, ...APPS.map((a) => a.name)];
const NAMESPACES = MEMBERS.map((m) => memberNamespace(GUID, m));
/** The label every member namespace of this tenant carries — how the purge finds the ones no source names. */
const TENANT_LABEL = `platform/tenant=${GUID}`;
const REQUEST: TenantPurgeRequest = { guid: GUID, stage: "prod", clusterId: "cls_1" };
/** The full step list: attest-target, the SHARED teardown steps (tenant-teardown.ts, prefixed
 *  `purge-<guid>-`) with the cluster-side cascade that makes purge destructive threaded in — the two
 *  deletes plus the wait that proves the tenant operator actually FINISHED the deprovision those deletes
 *  only requested — the fail-soft settle guard that re-reads the fan-out once they
 *  have fired, and the row flip LAST: a row may never claim the tenant removed while its Tenant CR, its
 *  namespace, its Applications or its unfinished deprovision still stand. */

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

/** A cluster-marking resolver that answers from a literal name -> stage map — mirrors registry.test.ts's
 *  helper. Both slaves this file commits registrations for are marked "prod". */
function marked(byName: Record<string, Stage>): ClusterStageResolver {
  return async (cluster: string) => {
    const stage = byName[cluster];
    if (!stage) throw new Error(`no cluster map for "${cluster}"`);
    return { name: cluster, stage };
  };
}
const CLUSTERS = marked({ s1: "prod", s2: "prod" });

/** The tenant as it stands in GitOps (one app) — committed by the tests that need a pointer. */
function entry(cluster = "s1"): TenantRegistration {
  return {
    members: testMembers([{ name: "erp", seedReference: false, seedDemo: false }]), identityProvider: "auth",
    cluster, subdomain: SUB, apps: [{ name: "erp", seedReference: false, seedDemo: false }],
    seedUsers: false, quota: seedQuota("small"), resetNonce: "1", suspended: false, quiesced: false,
  };
}

type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter; seeder?: VaultSeeder | null };

/** Records the crypto deletes a purge issues. The purge never SEEDS, so those throw: a purge that
 *  wrote a tenant's identity instead of destroying it would be the exact inverse of the run kind. */
class FakePurgeSeeder implements VaultSeeder {
  readonly deletedCrypto: TenantCryptoDeleteInput[] = [];
  async seed(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds"); }
  async seedPostgres(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds postgres"); }
  async seedMongodb(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds mongodb"); }
  async seedBuildRepoPat(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds a repo pat"); }
  async seedTenantCrypto(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds tenant crypto"); }
  async deleteTenantCrypto(i: TenantCryptoDeleteInput): Promise<void> { this.deletedCrypto.push(i); }
  async deleteBuildRepoPat(): Promise<void> {}
  async deleteApp(): Promise<void> {}
  async deletePostgres(): Promise<void> {}
  async deleteMongodb(): Promise<void> {}
}

function ports(reg: TenantRegistry, over: FakeKube = {}): TenantLifecyclePorts {
  return {
    registry: reg,
    // null models the Controller with no Vault wired at all — the one case where the crypto entry
    // survives a purge, which the run has to SAY rather than pass over.
    ...(over.seeder === null ? {} : { seeder: over.seeder ?? new FakePurgeSeeder() }),
    resolver: new FakeClusterKubeResolver({
      clusterReader: over.cluster ?? new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
      // Default: every fan-out name reads Missing (already pruned) — watch-prune logs a clean prune.
      argoReader: over.argo ?? new FakeMasterArgoReader(),
      projectWriter: over.projects ?? new FakeMasterProjectWriter(),
      argoNamespace: ARGO_NS,
    }),
    catalogRepoUrl: DEPLOY_REPO,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    dns: new FakeDnsProvider(),
  };
}

function ctx(stepName: string, p: Readonly<Record<string, unknown>>, logs: string[], runId = "run_tpurge"): StepCtx {
  return {
    runId, stepName, db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function planCtx(logs: string[] = []): PlanStreamCtx {
  return { db: db.db, log: (l) => logs.push(l), signal: new AbortController().signal };
}

/** The slave cluster only — NO tenants row. This is the ORPHAN precondition: a create-tenant that died
 *  before record-inventory left GitOps + cluster artifacts but nothing in inventory. */
function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

/** A SECOND registered slave, so a test can prove the plan refuses to purge a tenant that lives elsewhere. */
function seedSecondCluster(): void {
  db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "10.1.1.12", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", status: "active" }).run();
}

/** A cluster carrying the MASTER part. `role` picks which member — a pure master, or the union role a
 *  tenant is equally at home on. Either way the purge must reach the cluster-side deletes. */

/** The cluster PLUS the tenant's inventory rows — the INVENTORIED purge target: a tenant whose
 *  create-tenant run never finished, so record-provisional wrote the rows and record-inventory never
 *  settled them ("provisioning"). That is the row state a purge is legitimately FOR, and deliberately not
 *  "active": a tenant the inventory calls live whose pointer still stands is DEPLOYED, and attest-target
 *  refuses that purge outright (the shared live-tenant rule, tenant-live-guard.ts — its own end-to-end
 *  coverage lives in api-tenant-purge-guard.test.ts). Everything below is about what the teardown DOES to
 *  an inventoried tenant, which is identical either way: resolveTeardownTarget resolves any
 *  non-offboarded row, and the record step flips whatever it finds. */
function seedTenantRow(status: TenantStatus = "provisioning"): void {
  seedCluster();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: SUB, stage: "prod", members: TEST_MEMBERS, identityProvider: "auth", status }).run();
  db.db.insert(tenantApps).values({ id: "tna_erp", tenantId: "tnt_1", name: "erp", status }).run();
}

/** Plan through the streaming planner (the only planning path — the target must be resolved + frozen
 *  before steps() can build the shared teardown) and hand back the frozen params + the plan. */
async function planned(prt: TenantLifecyclePorts, req: TenantPurgeRequest = REQUEST, logs: string[] = []) {
  const result = await makeTenantPurgeDef(prt).planStream!(req, planCtx(logs));
  if (result.outcome !== "planned") throw new Error(`expected a planned outcome, got ${result.outcome}`);
  return result;
}

/** Run every step. Nothing is skipped by default any more: the run used to stop at a
 *  verify-deprovision that refused by design, because nothing deprovisioned a tenant. The two things
 *  that step could not vouch for now have owners — the Vault crypto entry is destroyed by
 *  delete-tenant-crypto here, and a member's databases go with the ServiceClaim finalizers that fire
 *  when delete-namespaces reaps their namespaces — so a purge completes on its own. `skip` stays for
 *  the tests that model an operator skipping a step with a reason. */
async function runAll(prt: TenantLifecyclePorts, p: TenantPurgeParams, logs: string[], skip: readonly string[] = []): Promise<void> {
  for (const step of makeTenantPurgeDef(prt).steps(p)) {
    if (!skip.includes(step.name)) await step.run(ctx(step.name, p, logs));
  }
}

/** Script the fan-out as still LIVE (Synced/Healthy) so allPruned fails — the "not pruned" case. */
function lingeringArgo(): FakeMasterArgoReader {
  const m = new Map<string, ArgoAppStatus>();
  for (const n of WATCH) m.set(n, { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" });
  return new FakeMasterArgoReader({ statuses: m });
}

describe("tenant-purge execution", () => {
  it("ORPHAN (no tenants row): reaps pointer, AppProject, Tenant CR and namespace by GUID and never throws", async () => {
    seedCluster(); // NO tenants row
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" }); // died after write-registration, before record-inventory
    const projects = new FakeMasterProjectWriter();
    for (const member of MEMBERS) {
      await projects.applyAppProject(ARGO_NS, renderTenantAppProject({ guid: GUID, member, argoNamespace: ARGO_NS, catalogRepoUrl: DEPLOY_REPO, platformRepoURL: PLATFORM_REPO, cluster: "s1" }));
    }
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    const prt = ports(reg, { projects, cluster });

    const logs: string[] = [];
    const { params } = await planned(prt);
    await runAll(prt, params, logs);

    expect(await reg.readTenant("prod", GUID)).toBeNull(); // pointer git-rm'd
    for (const member of MEMBERS) expect(projects.get(ARGO_NS, memberAppProject(GUID, member))).toBeUndefined(); // every member AppProject deleted
    expect(cluster.deletedNamespaces).toEqual(NAMESPACES); // the backstop reap fired on EVERY member namespace
    // The record step is a clean SOFT-SKIP: there is no row to mark, and none was invented. That must
    // survive every change to WHAT the record step writes (the purge gaining its own terminal
    // status was one such change): naming an orphan is the entire reason this run kind exists, and a record step that
    // insisted on a row would fail the one run that has none.
    expect(db.db.select().from(tenants).all()).toHaveLength(0);
    expect(logs.some((l) => l.includes(`purged tenant ${GUID} had no inventory row`))).toBe(true);
    // The Vault entry is destroyed by its own step, and the log names the path so an operator reading
    // the run sees the entry go rather than inferring it from a cascade that never existed.
    expect(logs.some((l) => l.includes(`crypto entry prod/tenants/${GUID} destroyed`))).toBe(true);
  });

  // THE ORPHAN BELT. The two orphan cases above are the reason this run kind exists, and both are
  // recognised by what the cluster shows: nothing of them RUNS. A tenant the inventory never learned
  // about but that still serves looks identical in git — same missing row, same standing pointer —
  // and purging it deletes its Tenant CR and with it, unrecoverably, its Vault path, its
  // object-storage credential and its Mongo databases. Only the cluster can tell the two apart.
  it("ORPHAN BELT: an uninventoried tenant whose workloads are RUNNING is refused, not purged", async () => {
    seedCluster(); // NO tenants row — indistinguishable from an orphan in git
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const cluster = new FakeClusterReader({
      deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 },
      namespacesByLabel: { [`platform/tenant=${GUID}`]: [NAMESPACES[0]!] },
      smoke: { namespaceExists: true, externalSecretsReady: true, workloads: [{ kind: "Deployment", name: "example-engine", available: true, desired: 1, ready: 1 }] },
    });
    const prt = ports(reg, { cluster });

    const { params } = await planned(prt);
    await expect(runAll(prt, params, [])).rejects.toThrow(/RUNNING/);

    // Nothing was touched: the belt sits in attest-target, step 0 of the mutating run.
    expect(cluster.deletedNamespaces).toEqual([]);
    expect(await reg.readTenant("prod", GUID)).not.toBeNull(); // the pointer still stands
  });

  it("ORPHAN with only an AppProject and NO pointer: still deletes the project, the Tenant CR and the namespace", async () => {
    seedCluster(); // no row, no pointer — create-tenant died at/around apply-appproject
    const projects = new FakeMasterProjectWriter();
    for (const member of MEMBERS) {
      await projects.applyAppProject(ARGO_NS, renderTenantAppProject({ guid: GUID, member, argoNamespace: ARGO_NS, catalogRepoUrl: DEPLOY_REPO, platformRepoURL: PLATFORM_REPO, cluster: "s1" }));
    }
    // NEITHER source knows this guid, so the frozen target names the trio alone. The erp namespace is
    // reachable only through the label the appsets stamp on every member namespace — which is why the
    // reap asks the cluster instead of trusting what it could derive.
    const cluster = new FakeClusterReader({
      deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 },
      namespacesByLabel: { [TENANT_LABEL]: NAMESPACES },
    });
    const prt = ports(new TenantRegistry(new FakePlatformRepo(), CLUSTERS), { projects, cluster });

    const logs: string[] = [];
    const { params } = await planned(prt);
    await expect(runAll(prt, params, logs)).resolves.toBeUndefined(); // every step fail-soft

    // EMPTY: no source here knows them, and the hardcoded trio that stood here was only ever true of
    // one product. The namespace reap finds them by label — asserted below.
    expect(cluster.deletedNamespaces).toEqual(NAMESPACES);
    expect(cluster.deletedNamespaces).toContain(memberNamespace(GUID, "erp")); // found by label alone
    expect(logs.some((l) => l.includes("pointer already removed"))).toBe(true); // remove-pointer no-op
  });

  it("INVENTORIED tenant: removes the pointer, RECORDS THE ROWS PURGED (not offboarded), then deprovisions", async () => {
    // The purge used to settle its rows to "offboarded" — the very
    // status tenant-offboard writes — so a tenant whose Tenant CR, Vault path, object-storage credential
    // and Mongo databases were all genuinely gone was indistinguishable in the inventory from one that
    // was merely un-deployed with every bit of that still standing. The consequence was visible on the
    // first screen: the tenant stayed in the "Offboarded tenants" panel, the count did not move, and the
    // row went on offering the purge it had just finished. The two states mean opposite things, so the
    // purge records its own.
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    const prt = ports(reg, { cluster });

    const logs: string[] = [];
    const { params } = await planned(prt);
    // The step announces the state it settles, so the run log and the row can never disagree.
    expect(makeTenantPurgeDef(prt).steps(params).at(-1)?.title).toBe(`Purge ${GUID}: record it purged`);
    await runAll(prt, params, logs);

    expect(await reg.readTenant("prod", GUID)).toBeNull();
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("purged"); // deprovisioned — and the row is still KEPT
    expect(row?.lastRunId).toBe("run_tpurge");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get()?.status).toBe("purged");
    expect(cluster.deletedNamespaces).toEqual(NAMESPACES);
    expect(logs.some((l) => l.includes(`purging tenant ${GUID} (subdomain "${SUB}")`))).toBe(true);
    expect(logs.some((l) => l.includes(`purged tenant ${GUID} recorded as purged (row kept)`))).toBe(true);
  });

  it("THE PRESCRIBED ORDER — offboard first, then purge: the purge deepens every app row the offboard settled", async () => {
    // The order the whole product prescribes (the Tenants page's settled panel, the offboard dialog, and
    // the purge's own live-tenant refusal: "offboard the tenant first ..., then purge whatever the
    // offboard leaves behind"), driven end to end through BOTH real runs — because the defect only
    // appears in the second one and only when the first has actually run.
    //
    // tenant-offboard settles the tenants row AND every tenant_apps row to "offboarded". The purge that
    // follows then found each app row already settled and skipped it, so it ended with the tenant
    // "purged" and every app of its matrix still "offboarded" — badged, on the tenant detail page, with
    // the word this change defines as "un-deployed, cluster state KEPT", directly above the bar stating
    // that the namespace, the Vault path and the Mongo databases are gone. They are: this purge deleted
    // the Tenant CR and the namespace those apps WERE.
    seedTenantRow("active");
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const cluster = new FakeClusterReader({
      deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 },
      // The purge that follows resolves NEITHER source, so its member list is the trio; the erp namespace
      // is found by the label the appsets stamp on every member namespace.
      namespacesByLabel: { [TENANT_LABEL]: NAMESPACES },
    });
    const prt = ports(reg, { cluster });

    // 1. The offboard: registration removed, fan-out pruned (the default fake reports every name Missing),
    //    AppProject deleted, rows settled "offboarded" — the tenant is un-deployed and everything it IS
    //    still stands, which is exactly why a purge is offered on it next.
    const logs: string[] = [];
    for (const s of makeOffboardTenantDef(prt).steps({ tenantId: "tnt_1" })) await s.run(ctx(s.name, { tenantId: "tnt_1" }, logs, "run_off"));
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("offboarded");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get()?.status).toBe("offboarded");

    // 2. The purge of what that offboard deliberately kept. Its pointer is already gone and its row is
    //    settled, so resolveTeardownTarget finds NEITHER source and the plan freezes the by-guid target —
    //    tenantId null, no fan-out to watch — which makes the record step take its (clusterId, guid)
    //    fallback, the same path the downgrade came in through.
    const { params } = await planned(prt);
    expect(params.target.tenantId).toBeNull();
    await runAll(prt, params, logs);

    expect(cluster.deletedNamespaces).toEqual(NAMESPACES);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("purged");
    const erp = db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get();
    expect(erp?.status).toBe("purged"); // NOT left at the offboard's "offboarded"
    expect(erp?.lastRunId).toBe("run_tpurge");
  });

  it("DESTROYS the tenant's crypto entry — the step that replaced the refusal", async () => {
    // This run used to stop here. verify-deprovision refused by design: its proof was the RELEASE of
    // the operator.hostyour.cloud/deprovision-complete finalizer, put on the Tenant CR by a reconciler
    // watching it, and no reconciler watches it — so the CR vanished at once and reading THAT as a
    // completed cascade would have recorded "purged" over a tenant whose crypto still stood.
    // The entry now has an owner: the same seeder that wrote it at create-tenant destroys it here, all
    // versions, so "purged" is a fact again rather than a request.
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    const seeder = new FakePurgeSeeder();
    const prt = ports(reg, { cluster, seeder });

    const logs: string[] = [];
    const { params } = await planned(prt);
    await runAll(prt, params, logs); // nothing skipped — the run completes on its own

    expect(seeder.deletedCrypto).toEqual([{ stage: "prod", guid: GUID }]);
    expect(await reg.readTenant("prod", GUID)).toBeNull();
    expect(cluster.deletedNamespaces).toEqual(NAMESPACES);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("purged");
  });

  it("destroys the crypto AFTER the namespaces, so nothing is left running that would read a missing key", async () => {
    // A member pod outliving its keys logs an auth failure that reads like a corruption rather than a
    // purge. The order is asserted on the step list, because a reordering is exactly the kind of edit
    // that looks harmless.
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const prt = ports(reg);
    const { params } = await planned(prt);
    const names = makeTenantPurgeDef(prt).steps(params).map((s) => s.name);
    expect(names.indexOf("delete-tenant-crypto")).toBeGreaterThan(names.indexOf("delete-namespaces"));
  });

  it("SAYS it when no seeder is wired — the one case where the crypto survives a purge", async () => {
    // The seeder is what WROTE the entry, so a Controller without Vault has nothing it could take
    // back. That is a leftover, and a leftover a purge passed over in silence is exactly what the
    // refusal existed to prevent — so the step names it instead, and the run still completes: the rest
    // of the footprint is reaped and the operator is told what to remove by hand.
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const prt = ports(reg, { seeder: null });

    const logs: string[] = [];
    const { params } = await planned(prt);
    await runAll(prt, params, logs);

    expect(logs.some((l) => l.includes("no Vault seeder is wired") && l.includes(`prod/tenants/${GUID}`))).toBe(true);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("purged");
  });

  it("records purged once the deprovision step is settled — the rows are the LAST thing to move", async () => {
    // The record step is the LAST one, after every reap and after the crypto delete, and the rows then
    // read purged — a distinct state from the "offboarded" an offboard leaves.
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    const prt = ports(reg, { cluster });

    const logs: string[] = [];
    const { params } = await planned(prt);
    await runAll(prt, params, logs);

    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("purged");
  });

  it("the purge flavour is the ONE teardown flavour that settles 'purged'", () => {
    // Stated on the flavour itself, beside the fail-soft prune policy, so the composing run's choice is
    // readable in one place rather than inferred from a run log (tenant-teardown.ts TenantTeardownOpts).
    expect(PURGE_TEARDOWN.settledStatus).toBe("purged");
  });

  it("watch-prune is FAIL-SOFT: a fan-out that never prunes does NOT stop the teardown", async () => {
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const prt = ports(reg, { argo: lingeringArgo() });
    const { params } = await planned(prt);
    const step = makeTenantPurgeDef(prt).steps(params).find((s) => s.name === `purge-${GUID}-watch-prune`)!;

    const logs: string[] = [];
    await expect(step.run(ctx(step.name, params, logs))).resolves.toBeUndefined(); // the replace flavour would THROW
    expect(logs.some((l) => l.includes("fan-out was not pruned") && l.includes("continuing"))).toBe(true);
  });

  it("a purge that OBSERVED lingering workloads reaps everything it can and then FAILS — it never settles the row", async () => {
    // Fail-soft used to make the WHOLE run soft: the watch observed a fan-out that never pruned, logged
    // "continuing", the two deletes ran, the record step flipped the rows to offboarded and the run ended
    // SUCCEEDED. That is the settled-but-unfinished state this whole change exists to end — an offboarded
    // row drops out of the Tenants list, its detail page offers no action, and the orphan scan cannot see
    // it either because purge-<guid>-remove git-rm'd its pointer, so a still-serving tenant becomes
    // unnameable. Fail-soft is about PROCEEDING (the Tenant CR + namespace deletes are the backstop and
    // must still fire), never about RECORDING: the settle guard fails the run at the last step before the
    // flip, which leaves the tenant listed and the run retryable from that step.
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    const prt = ports(reg, { argo: lingeringArgo(), cluster });

    const logs: string[] = [];
    const { params } = await planned(prt);
    await expect(runAll(prt, params, logs)).rejects.toThrow(/fan-out is STILL not pruned after the cluster-side deletes/);

    // The reap itself ran to the end: pointer gone, Tenant CR deleted (the deprovision cascade), namespace
    // deleted (the backstop). Nothing was held back because the prune could not be confirmed.
    expect(await reg.readTenant("prod", GUID)).toBeNull();
    expect(cluster.deletedNamespaces).toEqual(NAMESPACES);
    // The row, however, still says the tenant is there — which is what keeps it reachable for another try.
    const row = db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get();
    expect(row?.status).toBe("provisioning");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_erp")).get()?.status).toBe("provisioning");
  });

  it("is idempotent on a RE-RUN: a full purge twice over reaps once and never throws", async () => {
    seedTenantRow();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    const prt = ports(reg, { cluster });

    const logs: string[] = [];
    const { params } = await planned(prt);
    await runAll(prt, params, logs);
    // Second full pass over the SAME frozen params: pointer gone, project gone, CR + namespace gone,
    // row already purged. Nothing throws, and nothing is deleted twice. A re-purge staying harmless is
    // what lets the live-tenant rule keep ALLOWING it on a "purged" row (tenant-live-guard.ts) — the UI
    // simply stops advertising it — and it is the whole migration path for tenants purged before that
    // state existed: run the purge once more and the row records the truth.
    await expect(runAll(prt, params, logs)).resolves.toBeUndefined();
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("purged");
    // The crypto delete is 404-tolerant for exactly this: a second purge finds the entry gone.
    expect(logs.some((l) => l.includes(`crypto entry prod/tenants/${GUID} destroyed`))).toBe(true);
    expect(logs.some((l) => l.includes(`none of the ${NAMESPACES.length} tenant namespace(s) were still on s1`))).toBe(true);
  });


  it("attest-target fails closed on a deploy-state domain mismatch (never purge the wrong cluster)", async () => {
    seedCluster();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const prt = ports(reg, { cluster: new FakeClusterReader({ deployState: { domain: "other.example", stage: "prod", writtenAt: "x", generation: 1 } }) });
    const { params } = await planned(prt);
    const attest = makeTenantPurgeDef(prt).steps(params)[0]!;
    await expect(attest.run(ctx("attest-target", params, []))).rejects.toThrow(/deploy-state mismatch/);
  });

  it("attest-target re-checks the frozen target's cluster, so hand-crafted params cannot purge elsewhere", async () => {
    seedCluster();
    seedSecondCluster();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const prt = ports(reg);
    const { params } = await planned(prt);
    // A params set whose frozen target names s2 while the request targets cls_1 (s1).
    const crafted: TenantPurgeParams = { ...params, target: { ...params.target, clusterId: "cls_2", cluster: "s2" } };
    const attest = makeTenantPurgeDef(prt).steps(crafted)[0]!;
    await expect(attest.run(ctx("attest-target", crafted, []))).rejects.toThrow(/refusing to purge on the wrong cluster/);
  });

  it("attest-target refuses a member namespace carrying the relocating mark — a move holds the tenant", async () => {
    // The mark that ACTS: CLAIM_RELOCATING_ANNOTATION on the member namespaces is what makes the
    // service-provisioner KEEP a claim's databases when the repoint prunes the ServiceClaims. Purging
    // under it drops exactly the data the move is carrying. It used to read the Tenant CR's own
    // relocating annotation, on an object nothing reconciles and that no longer exists.
    seedCluster();
    const reg = new TenantRegistry(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const marked = memberNamespace(GUID, "auth");
    const cluster = new FakeClusterReader({
      deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 },
      namespacesByLabel: { [`platform/tenant=${GUID}`]: [marked] },
    });
    await cluster.annotateNamespace(marked, { [CLAIM_RELOCATING_ANNOTATION]: "true" });
    const prt = ports(reg, { cluster });
    const { params } = await planned(prt);
    await expect(makeTenantPurgeDef(prt).steps(params)[0]!.run(ctx("attest-target", params, []))).rejects.toThrow(/relocating/);
  });
});
