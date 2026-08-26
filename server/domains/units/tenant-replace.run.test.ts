import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "./unit-size.ts";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { resolveReplaceTargets, resolveTeardownTarget, type ReplaceTarget } from "./tenant-replace.ts";
import { tenantApplicationSet } from "./tenant-fanout.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { TenantValidationReport, TenantRegistration } from "../../../shared/tenant.ts";
import { STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";


// The create-tenant IDEMPOTENT-BY-SUBDOMAIN replace: a request whose subdomain
// already exists must offboard the old tenant, then deploy the fresh guid — never a parallel duplicate
// on the one public FQDN. Follows the tenant-ensure-images.run.test.ts pattern (a dedicated sibling
// file per concern) so create-tenant.run.test.ts stays within the 400-line doctrine.

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0"; // the NEW tenant (fixed-params runs green off the default statuses)
const OLD = "e2e8ymj86dk8"; // the existing same-subdomain tenant to replace
const SUB = "acme.example";
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
const REGISTRY_HOST = "zot.m1.example";
const APPS = [{ name: "erp" }];
const EXPECTED = tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], GUID, "prod");
const OLD_WATCH = tenantApplicationSet(TEST_MEMBERS, OLD, "prod");
// The old tenant's watch set once it ALSO has an inventory row: seedOldRow records one app ("legacy")
// that its pointer's apps[] does not carry, and a teardown must wait for BOTH sources' Applications —
// see the union test at the bottom of this file.
const OLD_WATCH_UNION = [...OLD_WATCH, `${OLD}-legacy-prod`];
// The trio ALONE — the members a teardown resolves to when the pointer's apps[] is empty and no
// inventory row adds another member (the ORPHAN case below).
const TRIO_MEMBERS = ["auth", "jobs", "report"];
// The trio plus the inventory-only "legacy" app — what seedOldRow's tenant_apps row adds on top of the
// trio every tenant always has (tenant-fanout.ts).
const TRIO_PLUS_LEGACY = [...TEST_MEMBERS, "legacy"];

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

const MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: catalog
owner: platform
envs: [dev, prod]
builds:
  - name: engine
    containerfile: Containerfile
tenant:
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true, namespaceLabels: { platform/redis-consumer: "true" } }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;

const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}`, raw: { kind }, ...over,
});
// No Tenant doc — the Tenant CR is provisioned by the Manager, never rendered by a chart (T3
// forbids it at cluster scope, same as any other cluster-scoped kind).
const CLEAN_DOCS = [
  doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }),
  doc("Deployment"),
];
const OPERATOR_LIVE: ArgoAppStatus = { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" };

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
// starts without it — and write-pointer resolves the tenant's ceiling against it.
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

function passReport(): TenantValidationReport {
  return composeTenantReport({
    resolvedSha: SHA, probeGuid: GUID, appsValidated: ["erp"], resolvedMembers: ["auth", "jobs", "report", "erp-engine", "erp-front"],
    startedAt: 1, finishedAt: 2, manifest: null,
    gates: [{ id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" }],
  });
}

function syncedStatuses(names: readonly string[], ref: string): Map<string, ArgoAppStatus> {
  const m = new Map<string, ArgoAppStatus>();
  for (const n of names) m.set(n, { syncRevision: ref, targetRevision: null, sync: "Synced", health: "Healthy" });
  return m;
}

/** A well-formed existing tenant registration (subdomain SUB) the registrations can commit as the replace target. */
function oldRegistration(over: Partial<TenantRegistration> = {}): TenantRegistration {
  return { cluster: "s1", subdomain: SUB, members: testMembers([]), identityProvider: "auth", apps: [], seedUsers: false, quota: seedQuota("small"), resetNonce: "1", suspended: false, quiesced: false, ...over };
}

/** A shared registrations over a seedable FakePlatformRepo, so a test can pre-commit the old pointer AND
 *  have planStream / the steps read it back through the SAME instance. */
function makeRegistrations(): TenantRegistrations {
  return new TenantRegistrations(new FakePlatformRepo(), CLUSTERS);
}

/** A VaultSeeder for the tenant runs: create-tenant seeds the crypto entry through it, and nothing
 *  else here touches Vault. `created: true` models the normal first run; the consumer-side methods
 *  throw, because a tenant run reaching one of them would be a wiring mistake, not a pass. */
function fakeTenantSeeder(): VaultSeeder {
  return {
    seed: () => Promise.reject(new Error("a tenant run never seeds a consumer entry")),
    seedPostgres: () => Promise.reject(new Error("a tenant run never seeds postgres")),
    seedMongodb: () => Promise.reject(new Error("a tenant run never seeds mongodb")),
    seedBuildRepoPat: () => Promise.reject(new Error("a tenant run never seeds a repo pat")),
    deleteBuildRepoPat: async () => {},
    deleteApp: async () => {},
    deletePostgres: async () => {}, deleteMongodb: async () => {},
    seedTenantCrypto: async () => ({ created: true }),
    deleteTenantCrypto: async () => {},
  };
}

function ports(registrations: TenantRegistrations): TenantOnboardPorts {
  return {
    // The Vault seeder the seed-tenant-crypto step writes through. Records nothing: what it wrote is
    // irrecoverable by design (the Manager holds no read grant), so a test can only assert THAT the
    // entry was created, which the step log carries.
    seeder: fakeTenantSeeder(),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({
        deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 },
        smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "erp-engine", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
      }),
      // Green the NEW fan-out set-watch + the ensure-operator single-app watch; the OLD guid's names are
      // absent from the map ⇒ they read Missing ⇒ allPruned passes for the replace watch-prune.
      argoReader: new FakeMasterArgoReader({ statuses: syncedStatuses(EXPECTED, SHA), status: OPERATOR_LIVE }),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  endpoints:\n    registry:\n      host: ${REGISTRY_HOST}\n` }],
    registryProbe: new FakeRegistryProbe(),
    dns: seededDns(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }],
    consumerNames: async () => [],
  };
}

/** The target cluster's own A record — what the replace's fresh provision-dns re-points the wildcard at. */
function seededDns(): FakeDnsProvider {
  const dns = new FakeDnsProvider();
  dns.seed("s1.example", "A", "203.0.113.10");
  return dns;
}

function params(over: Partial<CreateTenantParams> = {}): CreateTenantParams {
  return CreateTenantParams.parse({
    guid: GUID, subdomain: SUB, stage: "prod", clusterId: "cls_1", domain: "s1.example",
    members: testMembers(APPS),
    identityProvider: "auth",
    cluster: "s1", chartsRef: SHA, registryHost: REGISTRY_HOST,
    apps: APPS, seedUsers: false, quota: seedQuota("small"), owner: "team-acme",
    report: passReport(), expectedApps: EXPECTED, catalogRepoUrl: DEPLOY_URL,
    ...over,
  });
}

function ctx(p: CreateTenantParams, stepName: string, logs: string[]): StepCtx {
  return {
    runId: "run_rep", stepName, db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: {
      // What approve collected for this tenant: the two sealed storage values and the endpoint in
      // the clear. A create-tenant run refuses without them.
      get: (n: string) => ({
        "tenant-storage:key": Buffer.from("r2-access-key", "utf8"),
        "tenant-storage:secret": Buffer.from("r2-secret-key", "utf8"),
        "activation-input:storageEndpoint": Buffer.from("https://acct.eu.r2.cloudflarestorage.com", "utf8"),
      })[n],
      wipe: () => undefined,
    }, signal: new AbortController().signal,
    logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function planCtx(): PlanStreamCtx {
  return { db: db.db, log: () => undefined, signal: new AbortController().signal };
}

function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active", tier: "rehearsal" }).run();
}

/** Insert an inventory row for the old tenant (the INVENTORIED replace case). */
function seedOldRow(): void {
  db.db.insert(tenants).values({ id: "tnt_old", clusterId: "cls_1", guid: OLD, subdomain: SUB, stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "active" }).run();
  db.db.insert(tenantApps).values({ id: "tna_old", tenantId: "tnt_old", name: "legacy", status: "active" }).run();
}

async function runAll(p: CreateTenantParams, prt: TenantOnboardPorts, logs: string[]): Promise<void> {
  for (const step of makeCreateTenantDef(prt).steps(p)) await step.run(ctx(p, step.name, logs));
}

// The three steps that ALWAYS precede the replaces: attest-target (step 0), the execute-time
// subdomain belt, and record-provisional, which must land the inventory row before the first
// mutation — and a replace teardown git-rm's a pointer, so it counts as one.
const ONBOARD_HEAD = ["attest-target", "ensure-subdomain-free", "record-provisional"];
// The replaces sit BETWEEN the head and this tail, so seed-tenant-crypto belongs to the tail: the
// fresh guid's crypto entry is written after the old tenant of this subdomain is torn down, and
// before anything that reads it exists.
const ONBOARD_TAIL = ["seed-tenant-crypto", "ensure-images", "apply-appprojects", "provision-argo-sync", "provision-dns", "write-registration", "watch-sync-set", "smoke", "record-inventory", "activate"];
const replaceStepNames = (guid: string): string[] => [`replace-${guid}-remove`, `replace-${guid}-watch-prune`, `replace-${guid}-delete-projects`, `replace-${guid}-record`];

describe("create-tenant idempotent-by-subdomain — planStream resolves the replace set", () => {
  it("no existing subdomain: a plain onboard, NO offboard steps prepended", async () => {
    seedClusters();
    const def = makeCreateTenantDef(ports(makeRegistrations()));
    const result = await def.planStream!({ clusterId: "cls_1", subdomain: SUB, owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.replaces).toEqual([]);
    expect(result.plan.steps.map((s) => s.name)).toEqual([...ONBOARD_HEAD, ...ONBOARD_TAIL]);
    expect(result.plan.summary).not.toMatch(/Replaces/);
  });

  it("existing INVENTORIED subdomain: prepends the old tenant's offboard steps after attest-target", async () => {
    seedClusters();
    seedOldRow();
    const registrations = makeRegistrations();
    await registrations.commitTenant({ stage: "prod", guid: OLD, registration: oldRegistration(), runId: "run_old" });
    const def = makeCreateTenantDef(ports(registrations));
    const result = await def.planStream!({ clusterId: "cls_1", subdomain: SUB, owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.replaces).toEqual([
      { guid: OLD, subdomain: SUB, stage: "prod", clusterId: "cls_1", cluster: "s1", tenantId: "tnt_old", watchNames: OLD_WATCH_UNION, members: TRIO_PLUS_LEGACY },
    ]);
    // attest-target stays step 0 and record-provisional follows it (the row must exist before the
    // first mutation); the four replace steps then sit before the onboard proper.
    expect(result.plan.steps.map((s) => s.name)).toEqual([...ONBOARD_HEAD, ...replaceStepNames(OLD), ...ONBOARD_TAIL]);
    expect(result.plan.summary).toMatch(new RegExp(`Replaces existing ${OLD} \\(subdomain "${SUB}"\\) before deploying ${result.params.guid}`));
    // Approving the replace approves a PRUNE of the old tenant, and the prune's ServiceClaim deletions
    // drop the member databases — the summary must warn like tenant-offboard's does, before approval.
    expect(result.plan.summary).toContain("The replaced tenant's member DATABASES are NOT kept");
    expect(result.plan.summary).toContain("run a backup first");
  });

  it("existing ORPHAN subdomain (pointer present, NO db row): still a replace target, tenantId null", async () => {
    seedClusters(); // no seedOldRow ⇒ orphan
    const registrations = makeRegistrations();
    await registrations.commitTenant({ stage: "prod", guid: OLD, registration: oldRegistration(), runId: "run_old" });
    const def = makeCreateTenantDef(ports(registrations));
    const result = await def.planStream!({ clusterId: "cls_1", subdomain: SUB, owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    // The GitOps pointer scan caught the orphan (clusterId derived from the pointer's slave name).
    expect(result.params.replaces).toEqual([
      { guid: OLD, subdomain: SUB, stage: "prod", clusterId: "cls_1", cluster: "s1", tenantId: null, watchNames: OLD_WATCH, members: TRIO_MEMBERS },
    ]);
    expect(result.plan.steps.map((s) => s.name)).toEqual([...ONBOARD_HEAD, ...replaceStepNames(OLD), ...ONBOARD_TAIL]);
  });
});

describe("create-tenant idempotent-by-subdomain — the prepended steps execute the replace", () => {
  const invTarget: ReplaceTarget = { guid: OLD, subdomain: SUB, stage: "prod", clusterId: "cls_1", cluster: "s1", tenantId: "tnt_old", watchNames: OLD_WATCH, members: TRIO_MEMBERS };
  const orphanTarget: ReplaceTarget = { ...invTarget, tenantId: null };

  it("INVENTORIED: removes the old pointer, flips the old row to offboarded, then onboards the fresh guid", async () => {
    seedClusters();
    seedOldRow();
    const registrations = makeRegistrations();
    await registrations.commitTenant({ stage: "prod", guid: OLD, registration: oldRegistration(), runId: "run_old" });
    expect(await registrations.readTenant("prod", OLD)).not.toBeNull(); // the old tenant is live

    const prt = ports(registrations);
    const logs: string[] = [];
    await runAll(params({ replaces: [invTarget] }), prt, logs);

    // The old pointer is gone; the fresh guid's pointer is written.
    expect(await registrations.readTenant("prod", OLD)).toBeNull();
    expect(await registrations.readTenant("prod", GUID)).not.toBeNull();
    // The old inventory row + its app row flipped to offboarded (soft state — kept).
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_old")).get()?.status).toBe("offboarded");
    expect(db.db.select().from(tenantApps).where(eq(tenantApps.id, "tna_old")).get()?.status).toBe("offboarded");
    // The new tenant row was recorded active.
    expect(db.db.select().from(tenants).where(eq(tenants.guid, GUID)).get()?.status).toBe("active");
    expect(logs.some((l) => l.includes(`replacing existing tenant ${OLD}`) && l.includes(`subdomain "${SUB}"`))).toBe(true);
  });

  it("ORPHAN: the record step tolerates the missing db row (soft skip), still removes the pointer, then onboards", async () => {
    seedClusters(); // no old row
    const registrations = makeRegistrations();
    await registrations.commitTenant({ stage: "prod", guid: OLD, registration: oldRegistration(), runId: "run_old" });

    const prt = ports(registrations);
    const logs: string[] = [];
    await runAll(params({ replaces: [orphanTarget] }), prt, logs); // must NOT throw on the absent row

    expect(await registrations.readTenant("prod", OLD)).toBeNull(); // orphan pointer removed
    expect(await registrations.readTenant("prod", GUID)).not.toBeNull(); // fresh guid deployed
    expect(logs.some((l) => l.includes(`replaced tenant ${OLD} had no inventory row`))).toBe(true);
  });

  it("the replace remove step is idempotent on resume (an already-removed old pointer is skipped)", async () => {
    seedClusters();
    const registrations = makeRegistrations(); // pointer never committed ⇒ already absent
    const step = makeCreateTenantDef(ports(registrations)).steps(params({ replaces: [orphanTarget] })).find((s) => s.name === `replace-${OLD}-remove`)!;
    const logs: string[] = [];
    await step.run(ctx(params({ replaces: [orphanTarget] }), step.name, logs)); // no throw
    expect(logs.some((l) => l.includes("already removed") && l.includes("resume"))).toBe(true);
  });
});

describe("resolveReplaceTargets unions the DB inventory and the GitOps pointer scan", () => {
  it("dedupes a tenant present in BOTH sources into ONE target (tenantId from the row)", async () => {
    seedClusters();
    seedOldRow();
    const registrations = makeRegistrations();
    await registrations.commitTenant({ stage: "prod", guid: OLD, registration: oldRegistration(), runId: "run_old" });
    const targets = await resolveReplaceTargets({ db: db.db, registrations }, "prod", SUB);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.guid).toBe(OLD);
    expect(targets[0]!.tenantId).toBe("tnt_old");
  });

  it("ignores an already-offboarded inventory row and a different subdomain", async () => {
    seedClusters();
    db.db.insert(tenants).values({ id: "tnt_off", clusterId: "cls_1", guid: OLD, subdomain: SUB, stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "offboarded" }).run();
    const registrations = makeRegistrations(); // no live pointer either
    expect(await resolveReplaceTargets({ db: db.db, registrations }, "prod", SUB)).toEqual([]);
    expect(await resolveReplaceTargets({ db: db.db, registrations }, "prod", "other.example")).toEqual([]);
  });

  it("never picks up a PURGED row as a replace target — that tenant is deprovisioned, not displaced", async () => {
    // the DB source must skip BOTH terminal states, which is why it asks the shared
    // TENANT_SETTLED_STATUS set instead of testing `!== "offboarded"`. A purged guid returned here would
    // have create-tenant prepend a full teardown — pointer git-rm, fan-out prune watch, AppProject delete —
    // for a tenant that has nothing left to tear down; and because the replace policy is FAIL-LOUD, the
    // empty watch set that teardown resolves to is refused outright, so re-creating that subdomain would
    // not merely waste steps, it would FAIL.
    seedClusters();
    db.db.insert(tenants).values({ id: "tnt_purged", clusterId: "cls_1", guid: OLD, subdomain: SUB, stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "purged" }).run();
    expect(await resolveReplaceTargets({ db: db.db, registrations: makeRegistrations() }, "prod", SUB)).toEqual([]);
  });
});

// resolveTeardownTarget is the SINGLE resolution path resolveReplaceTargets (and every future
// teardown-driven run) builds its targets through — keyed on the guid alone, with NO subdomain to
// search by, so it is what makes an ORPHAN nameable at all.
describe("resolveTeardownTarget resolves ONE guid, with or without an inventory row", () => {
  it("WITH a DB row: takes tenantId + clusterId from the row, the watch set from BOTH sources", async () => {
    seedClusters();
    seedOldRow();
    const registrations = makeRegistrations();
    await registrations.commitTenant({ stage: "prod", guid: OLD, registration: oldRegistration(), runId: "run_old" });
    expect(await resolveTeardownTarget({ db: db.db, registrations }, "prod", OLD)).toEqual({
      guid: OLD, subdomain: SUB, stage: "prod", clusterId: "cls_1", cluster: "s1", tenantId: "tnt_old", watchNames: OLD_WATCH_UNION, members: TRIO_PLUS_LEGACY,
    });
  });

  it("WITHOUT a DB row: builds purely from the pointer — clusterId from its slave name, tenantId null", async () => {
    seedClusters(); // no seedOldRow ⇒ the ORPHAN case
    const registrations = makeRegistrations();
    await registrations.commitTenant({ stage: "prod", guid: OLD, registration: oldRegistration(), runId: "run_old" });
    expect(await resolveTeardownTarget({ db: db.db, registrations }, "prod", OLD)).toEqual({
      guid: OLD, subdomain: SUB, stage: "prod", clusterId: "cls_1", cluster: "s1", tenantId: null, watchNames: OLD_WATCH, members: TRIO_MEMBERS,
    });
  });

  it("an OFFBOARDED row is not authoritative — a live pointer still resolves, as an orphan would", async () => {
    seedClusters();
    db.db.insert(tenants).values({ id: "tnt_off", clusterId: "cls_1", guid: OLD, subdomain: SUB, stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "offboarded" }).run();
    const registrations = makeRegistrations();
    await registrations.commitTenant({ stage: "prod", guid: OLD, registration: oldRegistration(), runId: "run_old" });
    // The settled row is not flipped again: tenantId stays null, so the record step soft-skips.
    expect((await resolveTeardownTarget({ db: db.db, registrations }, "prod", OLD))?.tenantId).toBeNull();
  });

  it("a PURGED row is not authoritative either, and with nothing standing it resolves to nothing at all", async () => {
    // Both terminal states fall out of the row lookup together (TENANT_SETTLED_STATUS) — the single
    // resolution path is where "which rows still stand for a deployed tenant" is answered for every
    // teardown-driven run, so a purged row leaking through here would put a stale tenantId into a teardown
    // target and have its record step re-flip a row nothing removed. With no live
    // pointer beside it there is nothing safe to tear down, so the answer is null and the caller skips it.
    seedClusters();
    db.db.insert(tenants).values({ id: "tnt_purged", clusterId: "cls_1", guid: OLD, subdomain: SUB, stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "purged" }).run();
    expect(await resolveTeardownTarget({ db: db.db, registrations: makeRegistrations() }, "prod", OLD)).toBeNull();
  });

  it("a row whose pointer is ALREADY removed derives the watch set from the INVENTORY, never []", async () => {
    // THE FAILED-OFFBOARD STATE: tenant-offboard's remove-tenant committed the pointer removal and its
    // watch-removal then threw (timeout), so the registration is gone, the row is STILL active
    // (record-offboard never ran) and every fan-out Application keeps running. Freezing [] here would make
    // allPruned([]) vacuously true: the replace would log "fan-out pruned (0 Application(s))", delete
    // the isolation AppProject under live Applications and deploy the fresh guid onto the public FQDN the
    // OLD fan-out is still serving — two tenants on one FQDN, the exact invariant fail-loud exists to
    // protect. The inventory is the source that SURVIVES the git-rm (offboard's own watch-removal reads it
    // for the very same reason), so the set comes from there.
    seedClusters();
    seedOldRow();
    const registrations = makeRegistrations(); // the registration was never committed / already git-rm'd
    expect(await resolveTeardownTarget({ db: db.db, registrations }, "prod", OLD)).toEqual({
      guid: OLD, subdomain: SUB, stage: "prod", clusterId: "cls_1", cluster: "s1", tenantId: "tnt_old",
      watchNames: tenantApplicationSet([...TEST_MEMBERS, "legacy"], OLD, "prod"), members: TRIO_PLUS_LEGACY,
    });
  });

  it("names the tenant's CLUSTER even with no pointer to read it from — never the cls_ row id", async () => {
    // `cluster` is the cluster short name (the pointer's own field, the appset destination and the
    // AppProject pin), and it is what the run log and the tenant-purge PLAN tell the operator the tenant
    // lives on — on the very screen where a purge that drops Mongo databases is approved. With the
    // pointer gone (the failed-offboard state above) it used to fall back to the row's cls_-prefixed
    // clusterId, printing "cls_1" where the schema promises a cluster name. It is derived from the
    // cluster row's domain instead, through the SAME clusterShortName the two other producers honour —
    // and no stored field, in the plane or on the server row, can override it.
    seedClusters();
    db.db.update(clusters).set({ planeJson: { argo: { namespace: "s1-prod" } } }).where(eq(clusters.id, "cls_1")).run();
    db.db.update(servers).set({ name: "box-a" }).where(eq(servers.id, "srv_1")).run();
    seedOldRow();
    const target = await resolveTeardownTarget({ db: db.db, registrations: makeRegistrations() }, "prod", OLD);
    expect(target?.cluster).toBe("s1");
  });

  it("the watch set is the UNION of pointer and inventory — neither source alone is complete", async () => {
    // The two drift in BOTH directions mid-flight: an add-app writes the pointer before its row (the
    // pointer knows an app the inventory does not), a remove-app drops it from the pointer before flipping
    // the row (the inventory knows an Application ArgoCD is still pruning). Only the union waits for every
    // Application that can still be serving the tenant — and a superset is free, since an Application that
    // was never generated reads Missing and passes allPruned immediately.
    seedClusters();
    seedOldRow(); // inventory: app "legacy"
    const registrations = makeRegistrations();
    await registrations.commitTenant({ stage: "prod", guid: OLD, registration: oldRegistration({ apps: [{ name: "erp", seedReference: false, seedDemo: false }], members: testMembers(["erp"]) }), runId: "run_old" }); // pointer: app "erp"
    const target = await resolveTeardownTarget({ db: db.db, registrations }, "prod", OLD);
    expect(target?.watchNames).toEqual(tenantApplicationSet([...TEST_MEMBERS, ...[{ name: "erp" }, { name: "legacy" }].map((a) => a.name)], OLD, "prod"));
    // The MEMBERS union the same way — the pointer names "erp", the inventory names "legacy", and a
    // teardown must delete an AppProject for both or one is left standing after the removal.
    expect(target?.members).toEqual(["auth", "jobs", "report", "erp", "legacy"]);
  });

  it("tolerates an UNREADABLE registration the strict fold would throw on (the scan's tolerance)", async () => {
    // readTenant throws on a body that fails its schema — so a tenant whose registration carries a
    // malformed field could be LISTED by the orphan scan and yet never PLANNED for removal: its purge
    // would fail identically forever, and the same throw would block re-creating that subdomain
    // (resolveReplaceTargets resolves every same-subdomain guid through this function). The removal path
    // therefore resolves through the SCAN-grade read (scanTenant), which tolerates a body it cannot parse
    // and only needs to answer "is a file standing at this path" — and here it is not, so the target can
    // only come from the row.
    seedClusters();
    seedOldRow();
    const repo = new FakePlatformRepo();
    repo.seed(repo.booksBranch, `registrations/${OLD}/prod.yaml`, 'cluster: "s1"\nsubdomain: 7\n'); // subdomain must be a string
    const registrations = new TenantRegistrations(repo, CLUSTERS);
    await expect(registrations.readTenant("prod", OLD)).rejects.toThrow(/prod\.yaml failed its schema/); // the strict fold still refuses
    expect(await resolveTeardownTarget({ db: db.db, registrations }, "prod", OLD)).toEqual({
      guid: OLD, subdomain: SUB, stage: "prod", clusterId: "cls_1", cluster: "s1", tenantId: "tnt_old",
      watchNames: tenantApplicationSet([...TEST_MEMBERS, "legacy"], OLD, "prod"), members: TRIO_PLUS_LEGACY, // the row is what still resolves it
    });
  });

  it("neither source knows the guid ⇒ null — there is nothing safe to tear down", async () => {
    seedClusters();
    expect(await resolveTeardownTarget({ db: db.db, registrations: makeRegistrations() }, "prod", OLD)).toBeNull();
  });
});

// The replace set is frozen at PLAN time, and the locks that serialize two create-tenant runs are
// only taken at approve — so two plans for one subdomain can both freeze replaces=[] and be approved
// in turn. ensure-subdomain-free re-resolves the same-subdomain tenants at EXECUTE time and refuses
// any guid the approved plan did not name, so the second run stops instead of standing its fan-out
// beside the first on the one public FQDN. (A subdomain held ONLY by the plan's own replace targets
// passes — the runAll replace cases above walk through this step green.)
describe("ensure-subdomain-free — the execute-time uniqueness belt", () => {
  it("a subdomain taken since approval STOPS the run — never a second live registration on the FQDN", async () => {
    seedClusters();
    const registrations = makeRegistrations();
    // The concurrent create-tenant that won the race: its registration landed after this plan froze
    // replaces=[] and before this run's steps started.
    await registrations.commitTenant({ stage: "prod", guid: OLD, registration: oldRegistration(), runId: "run_other" });
    const p = params(); // replaces=[] — the plan saw a free subdomain
    await expect(runAll(p, ports(registrations), [])).rejects.toThrow(/no longer free/);
    // The belt refused BEFORE anything landed: the loser wrote no registration of its own.
    expect(await registrations.subdomainGuids("prod", SUB)).toEqual([OLD]);
    expect(db.db.select().from(tenants).where(eq(tenants.guid, GUID)).get()).toBeUndefined();
  });

  it("a subdomain that is an onboarded CONSUMER's name stops the run — the consumer already serves the cookie domain", async () => {
    // One name space, one apex: the consumer serves <name>.<unitApex>, and this tenant's example-auth
    // would scope every member's session cookie to exactly that host, so the browser would hand the
    // tenant's sessions to the consumer. Gate G23 holds the mirror of this on the consumer side.
    seedClusters();
    const registrations = makeRegistrations();
    const p = params();
    const prt = { ...ports(registrations), consumerNames: async () => ["unrelated", SUB] };
    await expect(runAll(p, prt, [])).rejects.toThrow(/onboarded consumer/);
    // Refused BEFORE anything landed — the belt sits ahead of record-provisional.
    expect(db.db.select().from(tenants).where(eq(tenants.guid, GUID)).get()).toBeUndefined();
    expect(await registrations.subdomainGuids("prod", SUB)).toEqual([]);
  });

  it("a RESUME passes over the run's OWN footprint — its row and registration already carry the subdomain", async () => {
    seedClusters();
    const registrations = makeRegistrations();
    const prt = ports(registrations);
    const p = params();
    // First pass: died right after write-registration — own row (provisioning) + own pointer stand.
    const logs: string[] = [];
    for (const step of makeCreateTenantDef(prt).steps(p)) {
      await step.run(ctx(p, step.name, logs));
      if (step.name === "write-registration") break;
    }
    // The resume re-walks from the top; the belt must not read the run's own guid as a foreign tenant.
    await runAll(p, prt, logs);
    expect(db.db.select().from(tenants).where(eq(tenants.guid, GUID)).get()?.status).toBe("active");
  });
});
