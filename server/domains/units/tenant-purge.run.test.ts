// The PLAN half of tenant-purge — what the run kind freezes before anything mutates: the target it
// resolves (row-derived or guid-only), the ordered steps, the locks, and every refusal that can be
// made from params and inventory alone. The EXECUTION half is tenant-purge.exec.test.ts; the two
// share this file's fixtures through the header both copies carry, and they were split along the
// 400-line budget, not along a seam in the subject.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeTenantPurgeDef, type TenantPurgeParams, type TenantPurgeRequest } from "./tenant-purge.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import { tenantApplicationSet } from "./tenant-fanout.ts";
import { FakePlatformRepo, FAKE_BOOKS_BRANCH } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { PlanStreamCtx } from "../../executor/types.ts";
import type { Stage, TenantStatus } from "../../../shared/enums.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import { ARGO_NS, STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";


// tenant-purge (force-offboard by GUID) tests — the tenant twin of
// purge.run.test.ts, over the same in-memory DB + fake git/kube clients the rest of the tenant family
// uses. The load-bearing NEW properties tenant-purge must have and tenant-offboard does not: it reaps a
// tenant from guid+stage+cluster ALONE (no tenants row — the orphaned partial create-tenant), it is
// FAIL-SOFT (a fan-out that never prunes does not stop the run), it deletes the Tenant CR (the operator
// deprovision cascade) and the namespace, and it is idempotent (a re-run is a no-op).

const GUID = "zsjs023ctne0";
const SUB = "acme.example";
const DEPLOY_REPO = "https://github.com/acme/acme-catalog.git";
const APPS = [{ name: "erp" }];
const WATCH = tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], GUID, "prod");
// The tenant's members — the trio plus its one app. Every one has a namespace and an AppProject of
// its own, so the purge reaps this many of each.
const MEMBERS = [...TEST_MEMBERS, ...APPS.map((a) => a.name)];
/** The label every member namespace of this tenant carries — how the purge finds the ones no source names. */
const REQUEST: TenantPurgeRequest = { guid: GUID, stage: "prod", clusterId: "cls_1" };
/** The full step list: attest-target, the SHARED teardown steps (tenant-teardown.ts, prefixed
 *  `purge-<guid>-`) with the cluster-side cascade that makes purge destructive threaded in — the two
 *  deletes plus the wait that proves the tenant operator actually FINISHED the deprovision those deletes
 *  only requested — the fail-soft settle guard that re-reads the fan-out once they
 *  have fired, and the row flip LAST: a row may never claim the tenant removed while its Tenant CR, its
 *  namespace, its Applications or its unfinished deprovision still stand. */
const STEP_ORDER = [
  "attest-target",
  `purge-${GUID}-remove`,
  `purge-${GUID}-watch-prune`,
  `purge-${GUID}-delete-projects`,
  "delete-namespaces",
  "delete-tenant-crypto",
  "remove-dns",
  `purge-${GUID}-verify-prune`,
  `purge-${GUID}-record`,
];

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

/** A cluster-marking resolver that answers from a literal name -> stage map — mirrors registrations.test.ts's
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

type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

function ports(reg: TenantRegistrations, over: FakeKube = {}): TenantLifecyclePorts {
  return {
    registrations: reg,
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
function seedMasterCluster(role: "master" | "master+slave" = "master"): void {
  db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "1.2.3.4", sshUser: "root", role, status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example", status: "active" }).run();
}

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

/** Run every step, skipping the ones an operator would skip. Nothing is skipped by
 *  default because it refuses BY DESIGN while nothing deprovisions a tenant — its own test below
 *  asserts that refusal, and every other test here is about what the purge REAPS, which the refusal
 *  would otherwise cut short. Skipping a step with a reason is what the executor offers an operator
 *  who has cleaned up by hand, so this models the only way a purge completes today. */

/** Script the fan-out as still LIVE (Synced/Healthy) so allPruned fails — the "not pruned" case. */

describe("tenant-purge plan", () => {
  it("plans with cluster targetKind, the ordered steps, the tenant locks and a summary that states the deprovision — with NO tenants row", async () => {
    seedCluster(); // orphan: cluster only, no tenants row
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" }); // a live pointer, never inventoried
    const { params, plan } = await planned(ports(reg));

    expect(makeTenantPurgeDef(ports(reg)).mutating).toBe(true);
    // The tenants row may not exist (orphan), so purge targets the CLUSTER, not "tenant".
    expect(plan.targetKind).toBe("cluster");
    expect(plan.targetId).toBe("cls_1");
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_ORDER);
    expect(plan.locks).toEqual([{ resource: "git-branch", key: `catalog@${FAKE_BOOKS_BRANCH}` }, { resource: "master-kube", key: "m" }]);
    expect(plan.requiredSecrets).toEqual([]);
    // The frozen target: resolved purely from the live pointer, so tenantId is null and the fan-out
    // watch set is the one the pointer describes (read BEFORE the teardown git-rm's it).
    expect(params.target).toEqual({ guid: GUID, subdomain: SUB, stage: "prod", clusterId: "cls_1", cluster: "s1", tenantId: null, watchNames: WATCH, members: MEMBERS });
    expect(plan.summary).toContain("no inventory row"); // the plan states the orphan case plainly
    // What is DESTROYED and what SURVIVES, spelled out where the operator approves. Both halves by
    // name: the databases go with the namespace reap (the ServiceClaim finalizers), the tenant's
    // identity with its Vault entry — and neither is stated as a cascade off an object nothing holds.
    expect(plan.summary).toContain(`Vault crypto entry prod/tenants/${GUID}`);
    expect(plan.summary).toContain("drops that claim's databases together with its user");
    expect(plan.summary).toContain("THE OBJECT-STORAGE BUCKET AND ITS DATA SURVIVE this purge");
    // ...and it is carried by the SUMMARY, not by a Plan.warning: nothing projects warnings onto RunView
    // (read.ts toRunView / shared api-types), so a warning would be a write-only second copy of a fact
    // the operator must actually read. The dialog that confirms the purge states it too.
    expect(plan.warnings).toEqual([]);
    // The LAST thing the operator reads before approving. It used to end "safe to re-run, and safe on a
    // healthy tenant", which meant "the steps will not error" and read as "if this is live, nothing bad
    // happens" — beside a sentence saying the Tenant CR delete drops the Mongo databases and the Vault
    // path. Idempotence is claimed for the re-run alone; the live case is stated as the destruction it is.
    expect(plan.summary).not.toMatch(/safe on a healthy tenant/);
    expect(plan.summary).toContain("Re-running the purge is safe");
    expect(plan.summary).toContain("never asks whether the tenant is still in use");
    expect(plan.summary).toContain("its Mongo databases and Vault path are gone for good");
  });

  it("freezes the INVENTORIED target (tenantId + row-derived cluster) for a tenant the inventory knows", async () => {
    seedTenantRow();
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry(), runId: "run_onb" });
    const { params, plan } = await planned(ports(reg));
    expect(params.target.tenantId).toBe("tnt_1");
    expect(params.target.watchNames).toEqual(WATCH);
    expect(plan.summary).not.toContain("no inventory row");
    // The plan says which STATE the rows are settled to, and says it where the operator approves
    //: "purged", not the "offboarded" every other removal writes. It used to
    // promise "mark the tenant + its app rows offboarded", which is what made a finished purge read as an
    // offboard on every screen afterwards.
    expect(plan.summary).toContain("mark the tenant + its app rows PURGED");
    expect(plan.summary).toContain("drops off the Tenants list and offers no further removal");
    expect(plan.summary).not.toMatch(/mark the tenant \+ its app rows offboarded/);
  });

  it("plans a guid NEITHER source knows: nothing to git-rm, no fan-out to watch, cluster footprint still reaped", async () => {
    seedCluster(); // no row, and no pointer was ever committed
    const { params, plan } = await planned(ports(new TenantRegistrations(new FakePlatformRepo(), CLUSTERS)));
    // A guid NEITHER source knows resolves to NO members: nothing here can name them, and a hardcoded
    // trio was only ever true of one product's tenants. The namespace reap asks the cluster by label
    // for whatever is standing, which is what actually finds them.
    expect(params.target).toEqual({ guid: GUID, subdomain: "", stage: "prod", clusterId: "cls_1", cluster: "s1", tenantId: null, watchNames: [], members: [] });
    expect(plan.steps.map((x) => x.name)).toEqual(STEP_ORDER); // the step list never shrinks
  });

  it("mutating def starts with attest-target under empty params (the armed check does def.steps({}))", () => {
    // guards.assertGuardsArmed evaluates def.steps({})[0].name — building the steps must not deref a
    // frozen target, so this must not throw and the first step must be attest-target.
    expect(makeTenantPurgeDef(ports(new TenantRegistrations(new FakePlatformRepo(), CLUSTERS))).steps({} as TenantPurgeParams)[0]?.name).toBe("attest-target");
  });

  it("plan() is a guard — the target must be resolved + frozen by the streaming planner", () => {
    // Refuses the synchronous planning path outright (like create-tenant / add-app): steps() cannot
    // build the shared teardown without a target resolved from the LIVE pointer first.
    const def = makeTenantPurgeDef(ports(new TenantRegistrations(new FakePlatformRepo(), CLUSTERS)));
    expect(() => def.plan({} as TenantPurgeParams, { db: db.db })).toThrow(/planned via planStream/);
  });

  it("fails closed on a stage that disagrees with the target cluster's own stage", async () => {
    seedCluster(); // cls_1 is prod
    const def = makeTenantPurgeDef(ports(new TenantRegistrations(new FakePlatformRepo(), CLUSTERS)));
    await expect(def.planStream!({ guid: GUID, stage: "dev", clusterId: "cls_1" }, planCtx())).rejects.toThrow(/stage mismatch/);
  });

  it.each(["master", "master+slave"] as const)("PLANS on a cluster carrying the %s role and still reaches the cluster-side deletes", async (role) => {
    // Placement is not a function of the role: a tenant runs wherever it was created, so a purge must be
    // able to reap it there. The two cluster-side deletes are what makes purge the removal that finishes,
    // and the manager reaches operator.hostyour.cloud on such a cluster through its own ServiceAccount
    // (ClusterRole manager-tenant-reaper) rather than a harvested bearer.
    seedMasterCluster(role);
    const def = makeTenantPurgeDef(ports(new TenantRegistrations(new FakePlatformRepo(), CLUSTERS)));
    const result = await def.planStream!({ guid: GUID, stage: "prod", clusterId: "cls_m" }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.plan.steps.map((st) => st.name)).toContain("delete-namespaces");
    expect(result.params.target.cluster).toBe("m1"); // clusterShortName of the cluster's domain
  });

  it("REFUSES to purge a tenant that lives on a DIFFERENT cluster than the one requested", async () => {
    seedCluster();
    seedSecondCluster();
    const reg = new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
    await reg.commitTenant({ stage: "prod", guid: GUID, registration: entry("s2"), runId: "run_onb" }); // the tenant is on s2
    const def = makeTenantPurgeDef(ports(reg));
    await expect(def.planStream!(REQUEST, planCtx())).rejects.toThrow(/lives on cluster cls_2 \("s2"\).*refusing to purge on the wrong cluster/);
  });
});
