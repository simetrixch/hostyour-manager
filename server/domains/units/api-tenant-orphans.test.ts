import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import type { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "../../domains/runs/run-definitions.ts";
import { getRun } from "../../executor/read.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerTenantRoutes } from "./api.ts";
import { makeCreateTenantDef, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { makeTenantPurgeDef } from "./tenant-purge.run.ts";
import { makeSuspendTenantDef } from "./tenant-lifecycle.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { AppEnv } from "../../http/app-env.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";

// The tenant ORPHAN SURFACE over HTTP: the two discovery reads that make an
// unrecorded tenant nameable at all, plus the purge trigger they hand their target to.
//   GET  /api/tenants/orphans                    — the GitOps pointer scan diffed against inventory
//   GET  /api/tenants/runs/:runId/tenant-state   — a create-tenant run's own tenant, resolved against
//                                                  inventory (its frozen guid + what the row says now)
//   POST /api/tenants/purge                      — the force-offboard, keyed on {guid, stage, clusterId}
// The through-line every test here defends: a tenant guid is MINTED by the create-tenant plan and typed
// by nobody, so each of these paths exists to HAND the operator a guid — none of them accepts one that
// an operator could have keyed in. Split into this sibling file because api.test.ts already sits at the
// 400-line budget, exactly as api-tenant-live.test.ts was.

const SHA = "a".repeat(40);
const ORPHAN_GUID = "e2e8ymj86dk8"; // a live-shaped throwaway guid (matches the tenants/** path guard)
const BROKEN_GUID = "kx4v7n2q9r3s"; // a pointer DIRECTORY whose tenant.yaml the scan cannot read
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const config = parseConfig({ PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

// The master self-cluster — a second ACTIVE cluster row beside the slave (the purge tests park
// inventory rows on both).
function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

// The slave a tenant lands on. Its server row is deliberately named "s1" while its cluster domain
// is s2.example: the pointers carry the cluster SHORT NAME "s2", derived from that domain, and
// that name is the only bridge from an orphan's pointer back to a cluster row (resolveClusterIdByName).
// The machine name is a machine name and takes no part in it.
function seedSlaveCluster(): void {
  db.db.insert(servers).values({ id: "srv_2", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", status: "active" }).run();
}

/** A cluster-marking resolver that answers every cluster short name at "prod" — every fixture in this
 *  file lands its tenant on s2/prod, so a single-stage stand-in is all TenantRegistrations needs to
 *  satisfy commitTenant's stage boundary check. */
const CLUSTER_STAGE: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

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
const tdoc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: ORPHAN_GUID, raw: { kind }, ...over,
});
// No Tenant CR document: the Manager provisions that object itself (provision-tenant-cr), and the
// T3 isolation gate now refuses a chart that renders one (CLUSTER_SCOPED_FORBIDDEN includes "Tenant").
const CLEAN_DOCS: RenderedDoc[] = [
  tdoc("Namespace", { namespace: "", raw: { kind: "Namespace" } }),
  tdoc("Deployment"),
];

function tenantResolver(): FakeClusterKubeResolver {
  return new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } }),
    argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
  });
}

function lifecyclePorts(registrations: TenantRegistrations): TenantLifecyclePorts {
  return { registrations, resolver: tenantResolver(), catalogRepoUrl: DEPLOY_URL, argoWatchTimeoutMs: 1000, resolveUnitApex: async () => "example.com", dns: new FakeDnsProvider() };
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

function onboardPorts(registrations: TenantRegistrations): TenantOnboardPorts {
  return {
    // The Vault seeder the seed-tenant-crypto step writes through. Records nothing: what it wrote is
    // irrecoverable by design (the Manager holds no read grant), so a test can only assert THAT the
    // entry was created, which the step log carries.
    seeder: fakeTenantSeeder(),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations,
    resolver: tenantResolver(),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: "https://github.com/simetrixch/hostyour-cloud.git",
    argoWatchTimeoutMs: 1000,
    registryProbe: new FakeRegistryProbe(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }],
    consumerNames: async () => [],
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: "installation/profile.yaml", content: `global:\n  endpoints:\n    registrations:\n      host: zot.m1.example\n` }],
  };
}

/** The tenant routes with the purge family wired. The registrations rides with the family exactly as it does
 *  in production (buildTenantOnboarding constructs BOTH or neither), so `enabled: false` also means "no
 *  pointer registrations" — which is what makes the scan route's degrade branch reachable. tenant-suspend is
 *  wired only so a test has a run of ANOTHER kind to point the purge-target route at. */
async function makeTenant(enabled: boolean): Promise<{ app: Hono<AppEnv>; executor: Executor; cookie: string; registrations: TenantRegistrations; repo: FakePlatformRepo }> {
  const store = new CredentialStore({ db: db.db, logger });
  const bus = new RunEventBus();
  const repo = new FakePlatformRepo(); // exposed so a test can plant a pointer the registrations would never write
  const reg = new TenantRegistrations(repo, CLUSTER_STAGE);
  const defs = enabled
    ? [makeCreateTenantDef(onboardPorts(reg)), makeTenantPurgeDef(lifecyclePorts(reg)), makeSuspendTenantDef(lifecyclePorts(reg))]
    : [];
  const executor = new Executor({ db: db.db, creds: store, bus, logger, runDefinitions: buildRunDefinitions({ db: db.db }, defs), sshFactory: noSsh, actor: () => "op_system" });
  const session = new SessionCodec(db.db, config);
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerTenantRoutes(a, { executor, db: db.db, onboardingEnabled: enabled, ...(enabled ? { registrations: reg } : {}) }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, executor, cookie, registrations: reg, repo };
}

/** A live tenant.yaml in the fake catalog — the ONE thing that makes a tenant an orphan when no
 *  tenants row accompanies it. Committed through the real registrations, so the scan reads exactly the bytes
 *  a create-tenant would have written. */
async function seedPointer(registrations: TenantRegistrations, guid: string, subdomain: string, over: Partial<TenantRegistration & { stage: Stage }> = {}): Promise<void> {
  const { stage = "prod", ...regOver } = over;
  const registration: TenantRegistration = {
    cluster: "s2", // clusterShortName of cls_2's domain (s2.example)
    members: testMembers([{ name: "erp", seedReference: false, seedDemo: false }]),
    identityProvider: "auth",
    subdomain,
    apps: [{ name: "erp", seedReference: false, seedDemo: false }],
    seedUsers: false, quota: seedQuota("small"),
    resetNonce: "1",
    suspended: false,
    quiesced: false,
    ...regOver,
  };
  await registrations.commitTenant({ stage, guid, registration, runId: "run_seed" });
}

// The tenant lands on cls_2 here; placement is free, so this is a fixture choice, not a rule.
const CREATE_REQ = { clusterId: "cls_2", subdomain: "acme.example", owner: "team-acme", apps: [{ name: "erp" }] };

describe("GET /api/tenants/orphans (the pointer scan)", () => {
  it("lists a live pointer with no inventory row, resolved to its cluster row", async () => {
    seedCluster();
    seedSlaveCluster();
    const { app, cookie, registrations } = await makeTenant(true);
    await seedPointer(registrations, ORPHAN_GUID, "ghost.example");
    const body = (await (await app.request("/api/tenants/orphans", authed(cookie))).json()) as { orphans: Array<Record<string, unknown>>; skipped: unknown[] };
    // Everything the operator needs to recognise it (subdomain/stage/slave) AND to aim a purge (clusterId).
    expect(body.orphans).toEqual([{ guid: ORPHAN_GUID, subdomain: "ghost.example", stage: "prod", cluster: "s2", clusterId: "cls_2" }]);
    expect(body.skipped).toEqual([]); // every pointer was read — the list is a complete answer
  });

  it("a pointer whose tenant IS recorded is not an orphan", async () => {
    seedCluster();
    seedSlaveCluster();
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_2", guid: ORPHAN_GUID, subdomain: "ghost.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "manager", status: "active" }).run();
    const { app, cookie, registrations } = await makeTenant(true);
    await seedPointer(registrations, ORPHAN_GUID, "ghost.example");
    expect(await (await app.request("/api/tenants/orphans", authed(cookie))).json()).toEqual({ orphans: [], skipped: [] });
  });

  it("carries every pointer it could NOT read to the browser — an empty list may never mean 'unchecked'", async () => {
    // The per-registration twin of the `error` field below: a registrations/<guid>/<stage>.yaml the scan could not parse
    // is neither confirmed nor ruled out as an orphan, so the route ships it (directory guid + reason)
    // and the Tenants page says "N pointers could not be read" instead of the all-clear sentence.
    seedCluster();
    seedSlaveCluster();
    const { app, cookie, registrations, repo } = await makeTenant(true);
    await seedPointer(registrations, ORPHAN_GUID, "ghost.example");
    // A hand-written pointer no writer of ours would produce, planted straight into the fake repo.
    repo.seed(repo.booksBranch, `registrations/${BROKEN_GUID}/prod.yaml`, "guid: not-a-guid\n");
    const body = (await (await app.request("/api/tenants/orphans", authed(cookie))).json()) as {
      orphans: Array<Record<string, unknown>>;
      skipped: Array<Record<string, unknown>>;
    };
    expect(body.orphans.map((o) => o["guid"])).toEqual([ORPHAN_GUID]); // the readable orphan is unaffected
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]).toMatchObject({ guid: BROKEN_GUID, stage: "prod" });
    expect(String(body.skipped[0]!["reason"])).toContain("failed its schema");
  });

  it("FAILS SOFT — an unreadable catalog answers 200 carrying the failure, never a bare empty list", async () => {
    // A silent [] would read as "no orphans found", the exact opposite of the truth, so the payload
    // carries `error` and the caller renders that instead of the (unknown) result. 200 keeps the Tenants
    // page alive through a git hiccup — the same degrade contract as the app-catalog route.
    const { app, cookie, registrations } = await makeTenant(true);
    registrations.listTenantPointers = () => Promise.reject(new Error("catalog unreachable"));
    const res = await app.request("/api/tenants/orphans", authed(cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orphans: [], skipped: [], error: "catalog unreachable" });
  });

  it("degrades to a reason (not 501) when tenant onboarding is not wired — it is a READ", async () => {
    const { app, cookie } = await makeTenant(false);
    expect(await (await app.request("/api/tenants/orphans", authed(cookie))).json()).toEqual({ orphans: [], skipped: [], reason: "onboarding-not-configured" });
  });
});

// The run screen's own discovery read. It answers what the run's tenant IS — resolved from the tenants
// ROW, never inferred from the run having failed — because the callout it feeds decides BOTH its copy
// and whether it offers a purge from that one answer.
describe("GET /api/tenants/runs/:runId/tenant-state (the run's tenant, as inventory has it)", () => {
  /** Plan a create-tenant and return its runId + the guid its plan minted (readable only from here). */
  async function planned(app: Hono<AppEnv>, executor: Executor, cookie: string): Promise<{ runId: string; guid: string }> {
    const { runId } = (await (await app.request("/api/tenants", { method: "POST", ...authed(cookie), body: JSON.stringify(CREATE_REQ) })).json()) as { runId: string };
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned");
    const body = (await (await app.request(`/api/tenants/runs/${runId}/tenant-state`, authed(cookie))).json()) as { target: { guid: string } };
    return { runId, guid: body.target.guid };
  }

  /** Mark this run's attest-target step ok — i.e. the run got PAST its fail-closed precondition, so every
   *  step after it (record-provisional first) was reached and it may have left a tenant behind. Written
   *  through the sqlite handle because runs/steps belong to the executor alone (the dep-cruiser rule
   *  only-executor-touches-runs-schema); the executor's own recovery test takes the same escape. */
  function pastPrecondition(runId: string): void {
    db.sqlite.prepare("UPDATE steps SET status='ok' WHERE run_id=? AND name='attest-target'").run(runId);
  }

  it("with NO inventory row and the precondition PASSED: ORPHAN, carrying {guid, subdomain, stage, clusterId}", async () => {
    // The PRECISE orphan path: when a create-tenant dies after it started deploying but before any row
    // was written (a run predating record-provisional), the minted guid lives ONLY in these params — the
    // pointer scan above could never see that tenant.
    seedCluster();
    seedSlaveCluster();
    const { app, executor, cookie } = await makeTenant(true);
    const { runId } = await planned(app, executor, cookie);
    pastPrecondition(runId);
    const body = (await (await app.request(`/api/tenants/runs/${runId}/tenant-state`, authed(cookie))).json()) as { state: string; target: Record<string, unknown> };
    expect(body.state).toBe("orphan");
    expect(body.target).toMatchObject({ subdomain: "acme.example", stage: "prod", clusterId: "cls_2" });
    expect(body.target["guid"]).toMatch(/^[0-9a-hjkmnp-tv-z]{12}$/); // minted by the plan, never supplied
    // The frozen params also carry the whole approved plan and the operator's adminEmail (PII), so the
    // route PROJECTS: nothing beyond these four fields can reach the browser.
    expect(Object.keys(body.target).sort()).toEqual(["clusterId", "guid", "stage", "subdomain"]);
  });

  it("REFUSED at attest-target: NOT-DEPLOYED — the run mutated nothing, so nothing is described or offered", async () => {
    // The other row-less run, and the opposite truth from the orphan above. This one is REAL, end to end:
    // the seeded slave cluster is s2.example while its deploy-state reports s1.example, so
    // attest-target (assertDeployState) refuses — the "deploy-state mismatch / unreachable slave" case.
    // record-provisional is the FIRST step after it and the only step before any mutation, so nothing was
    // deployed and no cleanup was armed. Read as "orphan" (the state a bare "no row" used to yield) the
    // screen would tell the operator the run "failed after it had started deploying" and that a fan-out,
    // an isolation AppProject, a namespace and a Tenant CR may still stand — none of which ever existed —
    // and the abort beside it would promise a teardown of a pointer that was never written.
    seedCluster();
    seedSlaveCluster();
    const { app, executor, cookie } = await makeTenant(true);
    const { runId } = await planned(app, executor, cookie);
    await executor.approve(runId, {
      // create-tenant demands the tenant's object storage at approve; without it the run refuses
      // before it reaches what this case is about.
      "tenant-storage:key": Buffer.from("r2-access-key", "utf8"),
      "tenant-storage:secret": Buffer.from("r2-secret-key", "utf8"),
      "activation-input:storageEndpoint": Buffer.from("https://acct.eu.r2.cloudflarestorage.com", "utf8"),
    });
    await executor.settle(runId);

    const run = getRun(db.db, runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "attest-target")?.status).toBe("failed");
    expect(run?.steps.find((s) => s.name === "record-provisional")?.status).toBe("pending"); // no row was ever written
    const body = (await (await app.request(`/api/tenants/runs/${runId}/tenant-state`, authed(cookie))).json()) as { state: string; target: Record<string, unknown> };
    expect(body.state).toBe("not-deployed");
    // The tenant is still NAMED (the plan minted and froze the guid) — it is simply not offered as
    // something to remove, and the same four projected fields ride along.
    expect(Object.keys(body.target).sort()).toEqual(["clusterId", "guid", "stage", "subdomain"]);
  });

  it("with an ACTIVE row: LIVE — the failed-at-`activate` run, which must NOT be offered a purge", async () => {
    // THE case this route exists for. `activate` is create-tenant's last step, placed after
    // record-inventory so a failed first-admin invite never rolls back a live deployment, and an HTTP
    // 503 from a freshly started tenant example-auth is a known live condition. The run is `failed` and
    // the tenant is SERVING — deciding from kind+status alone would offer to delete its Tenant CR.
    seedCluster();
    seedSlaveCluster();
    const { app, executor, cookie } = await makeTenant(true);
    const { runId, guid } = await planned(app, executor, cookie);
    db.db.insert(tenants).values({ id: "tnt_live", clusterId: "cls_2", guid, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "manager", status: "active" }).run();
    const body = (await (await app.request(`/api/tenants/runs/${runId}/tenant-state`, authed(cookie))).json()) as { state: string; row: Record<string, unknown> };
    expect(body.state).toBe("live");
    // The row rides along so the screen can badge the tenant exactly as the Tenants list does and link
    // to it, instead of describing a tenant it never read.
    expect(body.row).toEqual({ tenantId: "tnt_live", status: "active", suspended: false });
  });

  it("with a PROVISIONING row: UNFINISHED — the one row state a purge is the remedy for", async () => {
    seedCluster();
    seedSlaveCluster();
    const { app, executor, cookie } = await makeTenant(true);
    const { runId, guid } = await planned(app, executor, cookie);
    db.db.insert(tenants).values({ id: "tnt_half", clusterId: "cls_2", guid, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "manager", status: "provisioning" }).run();
    const body = (await (await app.request(`/api/tenants/runs/${runId}/tenant-state`, authed(cookie))).json()) as { state: string; row: Record<string, unknown> };
    expect(body.state).toBe("unfinished");
    expect(body.row).toMatchObject({ tenantId: "tnt_half", status: "provisioning" });
  });

  it("with an OFFBOARDED row: OFFBOARDED — the tenant is already gone, so nothing is offered", async () => {
    seedCluster();
    seedSlaveCluster();
    const { app, executor, cookie } = await makeTenant(true);
    const { runId, guid } = await planned(app, executor, cookie);
    db.db.insert(tenants).values({ id: "tnt_gone", clusterId: "cls_2", guid, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "manager", status: "offboarded" }).run();
    const body = (await (await app.request(`/api/tenants/runs/${runId}/tenant-state`, authed(cookie))).json()) as { state: string };
    expect(body.state).toBe("offboarded");
  });

  it("answers NONE + a reason when the run failed before its plan froze a guid", async () => {
    // cls_missing has no cluster row, so the streaming plan throws before minting anything and the run
    // still carries only its RAW request. Nothing was deployed ⇒ nothing to purge, and the operator is
    // told exactly that rather than offered a dead action.
    const { app, executor, cookie } = await makeTenant(true);
    const { runId } = (await (await app.request("/api/tenants", { method: "POST", ...authed(cookie), body: JSON.stringify({ ...CREATE_REQ, clusterId: "cls_missing" }) })).json()) as { runId: string };
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    const body = (await (await app.request(`/api/tenants/runs/${runId}/tenant-state`, authed(cookie))).json()) as { state: string; reason: string };
    expect(body.state).toBe("none");
    expect(body.reason).toContain("created nothing to purge");
  });

  it("404 for an unknown run, 400 for a run of another kind", async () => {
    seedCluster();
    db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: ORPHAN_GUID, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "manager", status: "active" }).run();
    const { app, cookie } = await makeTenant(true);
    expect((await app.request("/api/tenants/runs/run_missing/tenant-state", authed(cookie))).status).toBe(404);
    const { runId } = (await (await app.request("/api/tenants/tnt_1/suspend", { method: "POST", ...authed(cookie), body: "{}" })).json()) as { runId: string };
    expect((await app.request(`/api/tenants/runs/${runId}/tenant-state`, authed(cookie))).status).toBe(400);
  });
});

describe("POST /api/tenants/purge (the force-offboard trigger)", () => {
  it("201 + a runId that plans, for a guid with NO inventory row and NO pointer", async () => {
    // The hardest orphan: NEITHER source knows the guid (a create-tenant that died before write-registration),
    // so the plan falls back to reaping the cluster footprint by guid alone — and must still plan.
    seedCluster();
    seedSlaveCluster();
    const { app, executor, cookie } = await makeTenant(true);
    const res = await app.request("/api/tenants/purge", { method: "POST", ...authed(cookie), body: JSON.stringify({ guid: ORPHAN_GUID, stage: "prod", clusterId: "cls_2" }) });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("planned");
    expect(run?.kind).toBe("tenant-purge");
    expect(run?.targetId).toBe("cls_2"); // targets the CLUSTER — there may be no tenant row to target
    // The summary must not let an operator believe the stored objects went with the tenant.
    expect(run?.summary).toContain("THE OBJECT-STORAGE BUCKET AND ITS DATA SURVIVE");
  });

  it("plans against a LIVE pointer's fan-out when the orphan has one", async () => {
    seedCluster();
    seedSlaveCluster();
    const { app, executor, cookie, registrations } = await makeTenant(true);
    await seedPointer(registrations, ORPHAN_GUID, "ghost.example");
    const { runId } = (await (await app.request("/api/tenants/purge", { method: "POST", ...authed(cookie), body: JSON.stringify({ guid: ORPHAN_GUID, stage: "prod", clusterId: "cls_2" }) })).json()) as { runId: string };
    await executor.settle(runId);
    const run = getRun(db.db, runId);
    expect(run?.status).toBe("planned");
    expect(run?.summary).toContain("no inventory row"); // the plan names it an orphan out loud
    // The row flip is the LAST step: a tenant may never be recorded removed while its Tenant CR or its
    // namespace still stands (tenant-teardown.ts places the purge's deletes as its cascade), nor while
    // its crypto entry does (delete-tenant-crypto destroys it after the namespaces are reaped), nor
    // while its Applications do (the fail-soft settle guard re-reads the fan-out just before the flip).
    expect(run?.steps.map((s) => s.name)).toEqual([
      "attest-target",
      `purge-${ORPHAN_GUID}-remove`,
      `purge-${ORPHAN_GUID}-watch-prune`,
      `purge-${ORPHAN_GUID}-delete-projects`,
      "delete-namespaces",
      "delete-tenant-crypto",
      "remove-dns",
      `purge-${ORPHAN_GUID}-verify-prune`,
      `purge-${ORPHAN_GUID}-record`,
    ]);
  });

  it("a stage that disagrees with the target cluster fails the plan closed", async () => {
    // A mistyped stage would point the teardown at the wrong pointer path, so loadPurgeCluster refuses.
    seedCluster();
    seedSlaveCluster(); // cls_2 is prod
    const { app, executor, cookie } = await makeTenant(true);
    const { runId } = (await (await app.request("/api/tenants/purge", { method: "POST", ...authed(cookie), body: JSON.stringify({ guid: ORPHAN_GUID, stage: "dev", clusterId: "cls_2" }) })).json()) as { runId: string };
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("failed");
  });

  it("400 on a body that is not a {guid, stage, clusterId} identity", async () => {
    const { app, cookie } = await makeTenant(true);
    expect((await app.request("/api/tenants/purge", { method: "POST", ...authed(cookie), body: JSON.stringify({ guid: "NOT-A-GUID", stage: "prod", clusterId: "cls_2" }) })).status).toBe(400);
    expect((await app.request("/api/tenants/purge", { method: "POST", ...authed(cookie), body: "{}" })).status).toBe(400);
  });

  it("501 NOT_CONFIGURED when tenant onboarding is not wired", async () => {
    const { app, cookie } = await makeTenant(false);
    const res = await app.request("/api/tenants/purge", { method: "POST", ...authed(cookie), body: JSON.stringify({ guid: ORPHAN_GUID, stage: "prod", clusterId: "cls_2" }) });
    expect(res.status).toBe(501);
  });
});
