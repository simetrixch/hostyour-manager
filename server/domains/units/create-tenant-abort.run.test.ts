import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedUnitSizes } from "./unit-size.ts";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import type { Hono } from "hono";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "../runs/run-definitions.ts";
import { registerRunRoutes } from "../runs/api.ts";
import { getRun, getRunParams } from "../../executor/read.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { makeCreateTenantDef, CreateTenantParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { memberAppProject } from "./tenant-fanout.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeActivator } from "../../adapters/activation/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

/** The standing members the product under test declares — stated by the fixture, the way a real
 *  tenant's registration states its own. */
const TEST_MEMBERS = ["auth", "jobs", "report"];

// ABORT-WITH-CLEANUP on a create-tenant run, driven through the REAL executor (plan -> approve -> fail
// -> abort) rather than by calling steps by hand — because both properties under test are properties of
// that path and of nothing else.
//
//   1. THE ABORT MUST NOT UN-DEPLOY A LIVE TENANT. create-tenant's compensations ARE the shared teardown
//      (tenant-teardown.ts): git-rm the pointer, prune the whole fan-out, delete the isolation AppProject,
//      record the tenant offboarded. Executor.abortWithCleanup gates only on the RUN STATUS, which says
//      the run stopped and nothing about what undoing it would take off the cluster — and `activate` (the
//      first-admin invite) is deliberately the LAST step, AFTER record-inventory, so a run that failed
//      only there stands behind a tenant that is deployed, recorded active and serving. The run screen
//      hides the abort on such a tenant, but its tenant-state read is keyed on the run and the run's SSE
//      stream closes when the run settles, so a parked tab keeps offering it. The refusal therefore lives
//      on the DEFINITION (RunDefinition.assertAbortable → the shared live-tenant rule, tenant-live-guard.ts),
//      which is the only thing that knows what its own cleanups do — so it holds for every caller.
//
//   2. A RUN THAT NEVER GOT A USABLE PLAN MUST STILL BE ABORTABLE. A create-tenant that fails while still
//      `planning` carries only the operator's RAW request in params_json (beginStreamingPlan persists it
//      verbatim; only a settled plan overwrites it) and has no step rows at all. abortWithCleanup used to
//      parse those params against the FROZEN CreateTenantParams as its very first action — before the
//      "nothing was registered" early return — so the abort 500'd with a ZodError instead of settling the
//      run cancelled, leaving "Delete run" as the only way out of a run with nothing to clean up.
//
// Its own file (the create-tenant-provisional / -activate pattern) so create-tenant.run.test.ts stays
// inside the 400-line budget.

const SHA = "a".repeat(40);
const SUB = "acme.example";
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
const REQUEST = { clusterId: "cls_1", subdomain: SUB, owner: "team-acme", apps: [{ name: "erp" }] };
const config = parseConfig({ PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

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
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: "t", raw: { kind }, ...over,
});
// No Tenant CR document: the Manager provisions that object itself (provision-tenant-cr), and the
// T3 isolation gate now refuses a chart that renders one (CLUSTER_SCOPED_FORBIDDEN includes "Tenant").
const CLEAN_DOCS = [
  doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }),
  doc("Deployment"),
];

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
// starts without it — and write-pointer resolves the tenant's ceiling against it.
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

/** A cluster-marking resolver that answers every cluster short name at "prod" — every fixture in this
 *  file lands its tenant on s1/prod, so a single-stage stand-in is all TenantRegistrations needs to
 *  satisfy commitTenant's stage boundary check. */
const CLUSTER_STAGE: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

/** The slave a tenant lands on. */
function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

interface Harness {
  app: Hono<AppEnv>;
  cookie: string;
  executor: Executor;
  registrations: TenantRegistrations;
  argo: FakeMasterArgoReader;
  projects: FakeMasterProjectWriter;
  cluster: FakeClusterReader;
}

/** The create-tenant family wired to the in-memory fakes, behind the SAME kind-agnostic Runs API the
 *  browser calls — so the abort under test is exactly POST /api/runs/:id/abort, not a shortcut. */
async function harness(over: { activator?: FakeActivator } = {}): Promise<Harness> {
  const store = new CredentialStore({ db: db.db, logger });
  const bus = new RunEventBus();
  const registrations = new TenantRegistrations(new FakePlatformRepo(), CLUSTER_STAGE);
  const argo = new FakeMasterArgoReader();
  const projects = new FakeMasterProjectWriter();
  const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 3 } });
  // The bootstrap token the `activate` step reads off the target slave. The guid is minted by the plan,
  // so its namespace cannot be scripted up front — the reader answers for whichever namespace is asked.
  cluster.readSecretValue = () => Promise.resolve("boot_tok_abc");
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

  const ports: TenantOnboardPorts = {
      // The Vault seeder the seed-tenant-crypto step writes through. Records nothing: what it wrote is
      // irrecoverable by design (the Manager holds no read grant), so a test can only assert THAT the
      // entry was created, which the step log carries.
      seeder: fakeTenantSeeder(),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations,
    resolver: new FakeClusterKubeResolver({ clusterReader: cluster, argoReader: argo, projectWriter: projects, argoNamespace: "argocd" }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  endpoints:\n    registry:\n      host: zot.m1.example\n` }],
    dns: seededDns(),
    registryProbe: new FakeRegistryProbe(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }],
    consumerNames: async () => [],
    ...(over.activator ? { activator: over.activator } : {}),
  };
  // The sanctioned type-erasure at the registrations boundary, exactly as wire-units.ts does it.
  const def = makeCreateTenantDef(ports) as unknown as AnyRunDefinition;
  const executor = new Executor({ db: db.db, creds: store, bus, logger, runDefinitions: buildRunDefinitions({ db: db.db }, [def]), sshFactory: noSsh, actor: () => "op_system" });
  const session = new SessionCodec(db.db, config);
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerRunRoutes(a, { executor, db: db.db, bus, config, logger }),
  });
  return { app, cookie: await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" }), executor, registrations, argo, projects, cluster };
}

/** Plan through the streaming planner and hand back the runId + the params it FROZE (the minted guid and
 *  the expected fan-out set are only knowable from there — nothing else in the product mints a guid). */
async function planTenant(h: Harness, body: Record<string, unknown> = REQUEST): Promise<{ runId: string; params: CreateTenantParams }> {
  const { runId } = await h.executor.planStreamed("tenant-create", body);
  await h.executor.settle(runId);
  return { runId, params: CreateTenantParams.parse(getRunParams(db.db, runId)?.params) };
}

/** Script the whole fan-out — and the per-slave tenant operator's own Application — as Synced/Healthy, so
 *  ensure-operator and watch-sync-set both converge and the run reaches record-inventory. */
function scriptFanoutLive(h: Harness, p: CreateTenantParams): void {
  const live: ArgoAppStatus = { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" };
  h.argo.setStatus(live); // the single-app watch (ensure-operator)
  h.argo.setStatuses(new Map(p.expectedApps.map((n) => [n, live])));
}

const abortRun = async (h: Harness, runId: string): Promise<Response> =>
  await h.app.request(`/api/runs/${runId}/abort`, { method: "POST", ...authed(h.cookie) });

const tenantRow = (guid: string) => db.db.select().from(tenants).where(eq(tenants.guid, guid)).get();

describe("aborting a create-tenant run whose tenant went LIVE", () => {
  it("is REFUSED, and nothing of the deployed tenant is touched", async () => {
    // The exact shape the run screen cannot see: `activate` is the LAST step, so a 503 from a freshly
    // started tenant example-auth fails the run AFTER record-inventory settled the row to "active" and the
    // fan-out is serving. Aborting here would git-rm the pointer, prune the fan-out, delete the isolation
    // AppProject and mark the tenant offboarded — an un-deploy dressed as a rollback.
    seedClusters();
    const activator = new FakeActivator({ response: { status: 503, ok: false, json: null, bodyText: "Service Unavailable" } });
    const h = await harness({ activator });
    const { runId, params } = await planTenant(h, { ...REQUEST, adminEmail: "admin@acme.test" });
    scriptFanoutLive(h, params);
    await h.executor.approve(runId, {
      // The tenant's object storage, as approve collects it: without these the run refuses before
      // it reaches the step this scenario is about.
      "tenant-storage:key": Buffer.from("r2-access-key", "utf8"),
      "tenant-storage:secret": Buffer.from("r2-secret-key", "utf8"),
      "activation-input:storageEndpoint": Buffer.from("https://acct.eu.r2.cloudflarestorage.com", "utf8"),
    });
    await h.executor.settle(runId);

    // Precondition: a FAILED run standing behind a LIVE tenant — deployed, recorded, pointer committed.
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(getRun(db.db, runId)?.steps.find((s) => s.name === "activate")?.status).toBe("failed");
    expect(tenantRow(params.guid)?.status).toBe("active");
    expect(await h.registrations.readTenant("prod", params.guid)).not.toBeNull();

    const res = await abortRun(h, runId);
    expect(res.status).toBe(400); // was 202 — the cleanups ran and the tenant was un-deployed
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("VALIDATION");
    expect(body.message).toContain(`tenant ${SUB} (${params.guid}) is active in the inventory`);
    expect(body.message).toContain("would run its rollback");
    expect(body.message).toMatch(/tenant\.yaml still stands/);
    expect(body.message).toContain("offboard the tenant instead");

    // Nothing was scheduled and nothing ran: the tenant is exactly as it was, and so is the run.
    expect(await h.registrations.readTenant("prod", params.guid)).not.toBeNull();
    for (const member of [...TEST_MEMBERS, ...params.apps.map((a) => a.name)]) {
      expect(h.projects.get("argocd", memberAppProject(params.guid, member))).toBeDefined();
    }
    expect(tenantRow(params.guid)?.status).toBe("active");
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.some((s) => s.name.startsWith("cleanup:"))).toBe(false);
    expect(run?.steps.find((s) => s.name === "record-inventory")?.status).toBe("ok"); // not abandoned either
  });

  it("still rolls back the run it is FOR: an unfinished tenant is torn down as before", async () => {
    // The positive control. The run fails at watch-sync-set (no fan-out ever converged), so the row is
    // still "provisioning" — the state the abort exists for — and the refusal must stay out of its way.
    seedClusters();
    const h = await harness();
    const { runId, params } = await planTenant(h);
    h.argo.setStatus({ syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy" }); // only the operator app is live
    await h.executor.approve(runId, {
      // The tenant's object storage, as approve collects it: without these the run refuses before
      // it reaches the step this scenario is about.
      "tenant-storage:key": Buffer.from("r2-access-key", "utf8"),
      "tenant-storage:secret": Buffer.from("r2-secret-key", "utf8"),
      "activation-input:storageEndpoint": Buffer.from("https://acct.eu.r2.cloudflarestorage.com", "utf8"),
    });
    await h.executor.settle(runId);
    expect(getRun(db.db, runId)?.steps.find((s) => s.name === "watch-sync-set")?.status).toBe("failed");
    expect(tenantRow(params.guid)?.status).toBe("provisioning");

    expect((await abortRun(h, runId)).status).toBe(202);
    await h.executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("cancelled");
    expect(await h.registrations.readTenant("prod", params.guid)).toBeNull(); // pointer git-rm'd
    for (const member of [...TEST_MEMBERS, ...params.apps.map((a) => a.name)]) {
      expect(h.projects.get("argocd", memberAppProject(params.guid, member))).toBeUndefined(); // every member's AppProject deleted
    }
    expect(tenantRow(params.guid)?.status).toBe("offboarded");
  });
});

describe("aborting a create-tenant run that never got a usable plan", () => {
  it("settles it cancelled instead of 500-ing on its raw request params", async () => {
    // A plan that dies inside planStream (here: a clusterId no clusters row carries) leaves the run
    // `failed` with the operator's RAW request frozen in params_json and NO steps at all — so there is
    // nothing to compensate, and the abort's only job is to settle the run. Parsing those raw params
    // against CreateTenantParams — which needs the guid, stage, domain, cluster, chartsRef,
    // registryHost, report, expectedApps and catalogRepoUrl the plan never got to freeze — threw
    // a ZodError out of the route, so the operator got a red banner instead of a settled run.
    seedClusters();
    const h = await harness();
    const { runId } = await h.executor.planStreamed("tenant-create", { ...REQUEST, clusterId: "cls_nope" });
    await h.executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(getRun(db.db, runId)?.steps).toEqual([]); // no plan ⇒ no step rows were ever written

    expect((await abortRun(h, runId)).status).toBe(202);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.steps.some((s) => s.name.startsWith("cleanup:"))).toBe(false);
    expect(db.db.select().from(tenants).all()).toEqual([]); // it created nothing, so it undid nothing
  });
});

/** The target cluster's own A record — what provision-dns points the tenant's wildcard at. */
function seededDns(): FakeDnsProvider {
  const dns = new FakeDnsProvider();
  dns.seed("s1.example", "A", "203.0.113.10");
  return dns;
}
