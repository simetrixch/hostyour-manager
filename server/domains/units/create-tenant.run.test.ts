import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "./unit-size.ts";
import { seedQuota } from "../../../shared/unit-size.ts";
import { and, eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations, CATALOG_CHART_BRANCH } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { memberAppProject, tenantApplicationSet } from "./tenant-fanout.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo, FAKE_BOOKS_BRANCH } from "../../adapters/git/testing/fake.ts";
import { PRODUCT_BRANCH } from "../../../shared/branches.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { TenantValidationReport } from "../../../shared/tenant.ts";
import { STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";
import type { VaultSeeder, TenantCryptoSeedInput } from "../../adapters/vault/seeder-port.ts";
import { TENANT_CRYPTO_PROPERTIES, TENANT_STORAGE_PROPERTIES } from "./tenant-crypto-mint.ts";


const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0"; // a live-shaped throwaway guid
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
// The registry host the ports fixture resolves for the target cluster — in the default topology the
// build plane is the master, so the fixture answers zot on m1.example.
const REGISTRY_HOST = "zot.m1.example";
const APPS = [{ name: "erp" }];
const EXPECTED = tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], GUID, "prod");

/** A cluster-marking resolver that answers every cluster short name at "prod" — every fixture in this
 *  file lands its tenant on s1/prod, so a single-stage stand-in is all TenantRegistrations needs to
 *  satisfy commitTenant's stage boundary check. */
const CLUSTER_STAGE: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

// A schema-valid catalog fan-out manifest (build-only) — same shape validate-tenant.test.ts uses.
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
const NS_DOC = doc("Namespace", { namespace: "", raw: { kind: "Namespace" } });
// No Tenant CR document: the Manager provisions that object itself (provision-tenant-cr), and the
// T3 isolation gate now refuses a chart that renders one (CLUSTER_SCOPED_FORBIDDEN includes "Tenant").
const CLEAN_DOCS = [NS_DOC, doc("Deployment")];

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
// starts without it — and write-pointer resolves the tenant's ceiling against it.
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

function passReport(): TenantValidationReport {
  return composeTenantReport({
    resolvedSha: SHA, probeGuid: GUID, appsValidated: ["erp"], resolvedMembers: ["base", "auth", "erp-engine", "erp-front"],
    startedAt: 1, finishedAt: 2, manifest: null,
    gates: [{ id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" }],
  });
}

function syncedStatuses(names: readonly string[], ref: string): Map<string, ArgoAppStatus> {
  const m = new Map<string, ArgoAppStatus>();
  for (const n of names) m.set(n, { syncRevision: ref, targetRevision: null, sync: "Synced", health: "Healthy" });
  return m;
}

/** A green operator watch (ensure-operator's single-app watch reads the scripted `status`). */
const OPERATOR_LIVE: ArgoAppStatus = { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" };

function repoWithManifest(resolvedSha = SHA): FakeRepoReader {
  return new FakeRepoReader({ resolvedSha, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML } });
}

// The kube clients ride behind the resolver now: fold the per-test fakes (argo/cluster/
// projects) into a FakeClusterKubeResolver whose master path resolves to argoNamespace "argocd".
type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

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

function ports(over: Partial<TenantOnboardPorts> & FakeKube = {}): TenantOnboardPorts {
  const { argo, cluster, projects, ...portOver } = over;
  return {
    // The Vault seeder the seed-tenant-crypto step writes through. Records nothing: what it wrote is
    // irrecoverable by design (the Manager holds no read grant), so a test can only assert THAT the
    // entry was created, which the step log carries.
    seeder: fakeTenantSeeder(),
    repo: repoWithManifest(),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations: new TenantRegistrations(new FakePlatformRepo(), CLUSTER_STAGE),
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader({
        deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 },
        smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "erp-engine", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
      }),
      // statuses green the fan-out set-watch; status greens ensure-operator's single-app watch.
      argoReader: argo ?? new FakeMasterArgoReader({ statuses: syncedStatuses(EXPECTED, SHA), status: OPERATOR_LIVE }),
      projectWriter: projects ?? new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: "installation/profile.yaml", content: `global:\n  endpoints:\n    registrations:\n      host: ${REGISTRY_HOST}\n` }],
    // ensure-images defaults: every image present ⇒ the step is a pure probe/no-op, so the
    // existing suites never trigger a build (a test scripts missing tags to exercise that path).
    registryProbe: new FakeRegistryProbe(),
    dns: seededDns(),
    buildRbac: new FakeBuildRbacWriter(),
    // Who builds what, as the registration branch states it: example-platform builds the engine image
    // the tenant's apps pull, swissbookai is a unit beside it that builds none of them.
    attestedBuilds: async () => [
      { unit: "example-platform", build: "example-engine" },
      { unit: "swissbookai", build: "swissbookai-api" },
    ],
    consumerNames: async () => ["example-platform", "swissbookai"],
    ...portOver,
  };
}

/** The target cluster's own A record — what provision-dns points the tenant's wildcard at. */
function seededDns(): FakeDnsProvider {
  const dns = new FakeDnsProvider();
  dns.seed("s1.example", "A", "203.0.113.10");
  return dns;
}

function params(over: Partial<CreateTenantParams> = {}): CreateTenantParams {
  return CreateTenantParams.parse({
    guid: GUID, subdomain: "acme.example", stage: "prod", clusterId: "cls_1", domain: "s1.example",
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
    runId: "run_tnt", stepName, db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: {
      // What approve collected: the two sealed values and the endpoint in the clear. A tenant
      // created without them has an engine that refuses to boot, so no scenario here can omit them.
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

// Seed s1 as a slave for the test topology — resolveCluster itself is role-agnostic and requires
// only an ACTIVE cluster.
function seedSlave(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active", tier: "rehearsal" }).run();
}

// The slave plus the master self-cluster. `masterRole` picks which member of the word list carries
// the master part, so a test can put a tenant on a master+slave (the placement tests target cls_m).
function seedClusters(masterRole: "master" | "master+slave" = "master"): void {
  seedSlave();
  db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "5.6.7.8", sshUser: "root", role: masterRole, status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example", status: "active", tier: "rehearsal" }).run();
}

async function runAll(p: CreateTenantParams, prt: TenantOnboardPorts, logs: string[]): Promise<void> {
  for (const step of makeCreateTenantDef(prt).steps(p)) await step.run(ctx(p, step.name, logs));
}

describe("create-tenant run definition", () => {
  it("keeps attest-target first under `mutating` and refuses the synchronous plan() path", () => {
    const def = makeCreateTenantDef(ports());
    expect(def.mutating).toBe(true);
    expect(def.steps(params()).map((s) => s.name)).toEqual([
      "attest-target", "ensure-subdomain-free", "record-provisional", "seed-tenant-crypto", "ensure-images", "apply-appprojects", "provision-argo-sync", "provision-dns", "write-registration", "watch-sync-set", "smoke", "record-inventory", "activate",
    ]);
    // The boot self-check evaluates def.steps({}) with NO params at all, so building the step list must
    // dereference none of them. A tenant with no apps is still the trio, which is a real answer — but
    // the member list is what nearly broke this: it reads p.apps, and an unguarded read threw here and
    // took the whole guards.armed check down with it.
    expect(def.steps({} as CreateTenantParams)[0]?.name).toBe("attest-target");
    expect(() => def.plan({} as CreateTenantParams, { db: db.db })).toThrow(/planStream/);
  });

  it("walking skeleton: a tenant with one app onboards green against the fakes", async () => {
    seedClusters();
    const prt = ports();
    const logs: string[] = [];
    await runAll(params(), prt, logs);

    // write-registration committed the tenant registration; readTenant folds it back — INCLUDING the
    // cluster field, which the appsets read off registrations/<guid>/<stage>.yaml
    const read = await prt.registrations.readTenant("prod", GUID);
    expect(read?.entry.subdomain).toBe("acme.example");
    expect(read?.entry.apps).toEqual([{ name: "erp", seedReference: false, seedDemo: false }]); // default-absent seed tiers fold back false through the full run
    expect(read?.entry.suspended).toBe(false);
    expect(read?.entry.cluster).toBe("s1");

    // record-inventory wrote the tenant row + one tenant_apps row
    const row = db.db.select().from(tenants).where(eq(tenants.guid, GUID)).get();
    expect(row?.provenance).toBe("manager"); // the word onboard writes for a consumer — one act, one word
    expect(row?.clusterId).toBe("cls_1");
    expect(row?.subdomain).toBe("acme.example");
    expect(row?.lastRunId).toBe("run_tnt");
    const appRows = db.db.select().from(tenantApps).where(eq(tenantApps.tenantId, row!.id)).all();
    expect(appRows.map((a) => a.name)).toEqual(["erp"]);

    // attest + set-watch logged
    expect(logs.some((l) => l.includes("attested"))).toBe(true);
    expect(logs.some((l) => l.includes("Synced + Healthy"))).toBe(true);
  });

  it("apply-appprojects writes ONE isolation AppProject per member (Namespace-only whitelist, destination name-pinned) before the pointer", async () => {
    seedClusters();
    const projects = new FakeMasterProjectWriter();
    await runAll(params(), ports({ projects }), []);
    // The trio always, plus one per app — never a bare <guid> project, never a "base" member.
    const members = [...TEST_MEMBERS, ...APPS.map((a) => a.name)];
    expect(members).toEqual(["auth", "jobs", "report", "erp"]);
    for (const member of members) {
      const project = projects.get("argocd", memberAppProject(GUID, member));
      expect(project?.metadata.name).toBe(`${GUID}-${member}`);
      expect(project?.spec.sourceRepos).toEqual([DEPLOY_URL, PLATFORM_URL]);
      // The Tenant CR entry is gone — the Manager writes that object itself, never a chart.
      expect(project?.spec.clusterResourceWhitelist).toEqual([{ group: "", kind: "Namespace" }]);
      // The destination pins the tenant's OWN slave by ArgoCD cluster name — never server "*" — and
      // confines this member to its own namespace, never a sibling's.
      expect(project?.spec.destinations).toEqual([{ name: "s1", namespace: `${GUID}-${member}` }]);
    }
  });


  it("attest-target fails closed when the cluster has no deploy-state", async () => {
    const prt = ports({ cluster: new FakeClusterReader({ deployState: null }) });
    const step = makeCreateTenantDef(prt).steps(params())[0]!;
    await expect(step.run(ctx(params(), "attest-target", []))).rejects.toThrow(/deploy-state/);
  });

  it("provision-dns creates the tenant's ONE wildcard record, pointing at the target cluster's own address", async () => {
    const dns = seededDns();
    const p = params();
    const step = makeCreateTenantDef(ports({ dns })).steps(p).find((s) => s.name === "provision-dns")!;
    const logs: string[] = [];
    await step.run(ctx(p, "provision-dns", logs));
    // ONE wildcard covers every member host `<member>.<subdomain>.<unitApex>` — members added later
    // included — and its content is the cluster's own A record, read, never computed.
    expect(dns.record("*.acme.example.example.com", "A")).toBe("203.0.113.10");
    expect(logs.some((l) => l.includes("a move is a content update of exactly this record"))).toBe(true);
  });

  // The ensure-images gate's run-level tests (placement, probe behavior, planStream
  // freezing) live in their OWN file — tenant-ensure-images.run.test.ts (the onboard-activate
  // pattern) — so this suite stays within the file-size doctrine.

  it("record-inventory is overwrite-idempotent (a resume re-runs it)", async () => {
    seedClusters();
    const p = params();
    const rec = makeCreateTenantDef(ports()).steps(p).find((s) => s.name === "record-inventory")!;
    await rec.run(ctx(p, "record-inventory", []));
    await rec.run(ctx(p, "record-inventory", []));
    const rows = db.db.select().from(tenants).where(eq(tenants.guid, GUID)).all();
    expect(rows).toHaveLength(1);
    const appRows = db.db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, rows[0]!.id), eq(tenantApps.name, "erp"))).all();
    expect(appRows).toHaveLength(1);
  });
});

describe("create-tenant streaming planner", () => {
  it("mints a free guid, validates the fan-out, and freezes a plan (targetKind cluster, catalog lock)", async () => {
    seedClusters();
    const def = makeCreateTenantDef(ports());
    const result = await def.planStream!({ clusterId: "cls_1", subdomain: "acme.example", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.guid).toMatch(/^[0-9a-hjkmnp-tv-z]{12}$/);
    expect(result.params.chartsRef).toBe(SHA);
    expect(result.params.expectedApps).toEqual(tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], result.params.guid, "prod"));
    expect(result.plan.targetKind).toBe("cluster");
    expect(result.plan.targetId).toBe("cls_1");
    expect(result.plan.locks).toContainEqual({ resource: "git-branch", key: `catalog@${FAKE_BOOKS_BRANCH}` }); // the books branch, not the trunk the charts stand on
    // The tenant's object storage: the two sealed values approve demands, and the endpoint in the
    // clear beside them. Everything else a tenant needs is minted or derived — these three are made
    // at Cloudflare with a token this tier deliberately does not hold.
    expect(result.plan.requiredSecrets).toEqual(["tenant-storage:key", "tenant-storage:secret"]);
    expect(result.plan.requiredInputs?.map((i) => i.field)).toEqual(["storageEndpoint"]);
    expect(result.plan.steps.map((s) => s.name)).toEqual(def.steps(result.params).map((s) => s.name));
  });

  it("validates the member CHARTS at the trunk while the registration is locked on the books branch — the two are not one value", async () => {
    // catalog carries both, and they are different kinds of thing: the charts are product, the
    // same ones for every installation, and the registrations are this installation's books. One
    // constant for both is what would have moved the charts onto a branch nothing maintains the
    // moment the registrations moved — silently, since every render would still resolve.
    seedClusters();
    const reader = repoWithManifest();
    const result = await makeCreateTenantDef(ports({ repo: reader }))
      .planStream!({ clusterId: "cls_1", subdomain: "acme.example", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(reader.clones.map((c) => c.ref)).toEqual([CATALOG_CHART_BRANCH]);
    expect(CATALOG_CHART_BRANCH).toBe(PRODUCT_BRANCH);
    expect(result.plan.locks).toContainEqual({ resource: "git-branch", key: `catalog@${FAKE_BOOKS_BRANCH}` });
  });

  it("resolves the slave's NAME off clusters.domain and freezes the registryHost the target cluster resolves to", async () => {
    seedClusters(); // s1.example slave + m1.example master
    const def = makeCreateTenantDef(ports());
    const result = await def.planStream!({ clusterId: "cls_1", subdomain: "acme.example", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.cluster).toBe("s1"); // clusterShortName of clusters.domain
    expect(result.params.registryHost).toBe(REGISTRY_HOST); // registryHostFromChain over what ports.resolveClusterValueFiles answered
  });

  // The registry-host freeze against a cluster whose build plane is NOT its master lives in
  // tenant-ensure-images.run.test.ts (the registry-host pivot's own file, per the file-size doctrine).

  it("renders EVERY member — the trio's jobs + report charts among them, unconditionally", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } });
    const def = makeCreateTenantDef(ports({ helm }));
    const result = await def.planStream!({ clusterId: "cls_1", subdomain: "acme.example", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    // jobs and report render for EVERY tenant — nothing gates them, not a flag, not the presence of a file.
    expect(helm.requests.map((r) => r.chartPath)).toEqual(expect.arrayContaining(["charts/example-jobs", "charts/example-report"]));
  });

  // Placement is anywhere: the role says who OPERATES the management plane, never where a unit may
  // land. What still gates a target is the cluster's STATUS, which resolveCluster keeps checking.
  it.each(["master", "master+slave"] as const)("plans a tenant onto the cluster carrying the %s role", async (role) => {
    seedClusters(role);
    const result = await makeCreateTenantDef(ports()).planStream!({ clusterId: "cls_m", subdomain: "a.example", owner: "o", apps: [] }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect([result.params.clusterId, result.params.cluster, result.params.domain]).toEqual(["cls_m", "m1", "m1.example"]);
  });

  it("plans with NO master cluster registered — the registrations comes off the target cluster's chain, not a master row", async () => {
    seedSlave(); // slave only — no master row anywhere in inventory
    const result = await makeCreateTenantDef(ports()).planStream!({ clusterId: "cls_1", subdomain: "a.example", owner: "o", apps: [] }, planCtx());
    expect(result.outcome === "planned" && result.params.registryHost).toBe(REGISTRY_HOST);
  });

  it("freezes the full report as a rejection when a member escapes the namespace fence (T3)", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [doc("ClusterRole")] } });
    const def = makeCreateTenantDef(ports({ helm }));
    const result = await def.planStream!({ clusterId: "cls_1", subdomain: "acme.example", owner: "o", apps: [] }, planCtx());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toMatch(/T3/);
    expect((result.planJson as TenantValidationReport).verdict).toBe("fail");
  });
});

describe("seed-tenant-crypto (the entry every member namespace reads)", () => {
  /** Runs just that step against a scripted seeder, and hands back what it was asked to write. */
  async function seedStep(over: Partial<VaultSeeder> = {}): Promise<{ seen: TenantCryptoSeedInput[]; logs: string[] }> {
    const seen: TenantCryptoSeedInput[] = [];
    const prt = ports({
      seeder: {
        ...fakeTenantSeeder(),
        seedTenantCrypto: async (i: TenantCryptoSeedInput) => {
          seen.push(i);
          return { created: true };
        },
        ...over,
      },
    });
    const logs: string[] = [];
    const p = params();
    const step = makeCreateTenantDef(prt).steps(p).find((s) => s.name === "seed-tenant-crypto")!;
    await step.run(ctx(p, step.name, logs));
    return { seen, logs };
  }

  it("writes the tenant's own leaf with every property its members read", async () => {
    const { seen } = await seedStep();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.stage).toBe("prod");
    expect(seen[0]!.guid).toBe(GUID); // the BARE guid — the leaf name the members' ACL template resolves to
    // ONE entry, one create-only write: the five minted values AND the three the operator handed
    // over. Splitting them would mean a second write against a path cas=0 makes write-once.
    expect(Object.keys(seen[0]!.data).sort()).toEqual([...TENANT_CRYPTO_PROPERTIES, ...TENANT_STORAGE_PROPERTIES].sort());
    expect(seen[0]!.data["upload-s3-endpoint"]).toBe("https://acct.eu.r2.cloudflarestorage.com");
  });

  it("runs BEFORE write-registration — the fan-out must never generate a member whose secrets do not exist yet", async () => {
    // The moment the registration lands, the tenant ApplicationSets generate every member Application
    // and each one's ExternalSecrets resolve against this entry. Seeding after would fan out into pods
    // that cannot start and ExternalSecrets reporting SecretSyncedError.
    const names = makeCreateTenantDef(ports()).steps(params()).map((s) => s.name);
    expect(names.indexOf("seed-tenant-crypto")).toBeLessThan(names.indexOf("write-registration"));
    expect(names.indexOf("seed-tenant-crypto")).toBeLessThan(names.indexOf("watch-sync-set"));
    // ...and AFTER record-provisional, so nothing is written for a tenant the inventory cannot name.
    expect(names.indexOf("seed-tenant-crypto")).toBeGreaterThan(names.indexOf("record-provisional"));
  });

  it("an entry that ALREADY stands is left untouched, and the run says so", async () => {
    // The create-only contract, from the step's side: the mint is unconditional, so a re-run produces
    // fresh values every time and the WRITE is what refuses. The log has to state that nothing was
    // rotated — an operator re-running create-tenant on a live tenant needs to read exactly that.
    const { logs } = await seedStep({ seedTenantCrypto: async () => ({ created: false }) });
    expect(logs.some((l) => l.includes("already exists and was left UNTOUCHED"))).toBe(true);
    expect(logs.some((l) => l.includes("never rotates a live tenant's keys"))).toBe(true);
  });

  it("never puts a minted value in the log — nothing can recover them after this step", async () => {
    // The Manager holds no read grant on this path, so the values are irrecoverable by design. A log
    // line carrying one would be the only copy left, in the one place that gets shipped to an operator.
    const { seen, logs } = await seedStep();
    const secrets = Object.values(seen[0]!.data);
    for (const line of logs) for (const s of secrets) expect(line).not.toContain(s);
  });

  it("fails LOUD with no seeder wired, rather than producing a tenant that cannot resolve one secret", async () => {
    const { seeder: _drop, ...rest } = ports();
    const p = params();
    const step = makeCreateTenantDef(rest as TenantOnboardPorts).steps(p).find((s) => s.name === "seed-tenant-crypto")!;
    await expect(step.run(ctx(p, step.name, []))).rejects.toThrow(/no Vault seeder is wired/);
  });
});
