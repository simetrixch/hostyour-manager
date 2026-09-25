import { dropCredentialRows } from "../../security/store.fixture.ts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts"; import { REQUIRED_ENV } from "../../kernel/config.fixture.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { CredentialStore } from "../../security/store.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "../../domains/runs/run-definitions.ts";
import { getRun } from "../../executor/read.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerConsumerRoutes, registerTenantRoutes } from "./api.ts";
import { makeOnboardDef, type OnboardPorts } from "./onboard.run.ts";
import { CHANNEL_STAGES, emptyZone } from "./onboard.fixture.ts";
import { makeOffboardDef } from "./offboard.run.ts";
import { makeSuspendDef, makeResumeDef } from "./suspend-resume.run.ts";
import { makeCreateTenantDef, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { makeAddAppDef } from "./add-app.run.ts";
import { makeSuspendTenantDef, makeResumeTenantDef, makeRemoveAppDef } from "./tenant-lifecycle.run.ts";
import { makeOffboardTenantDef } from "./tenant-offboard.run.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { seedClusterMaps } from "./cluster-map.fixture.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGateRunner } from "../../adapters/gate-runner/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import type { LifecyclePorts, TenantLifecyclePorts } from "./lifecycle.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { GateReport } from "../../../shared/gates.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";
import type { AppEnv } from "../../http/app-env.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { seedUnitSizes } from "#unit/server/unit-size.ts";
import { APP_OVERLAYS } from "./tenant-members.fixture.ts";
import { ORG, TEMPLATE_SPEC, withAppsTemplate, recordTestOwners } from "./tenant-apps-repo.fixture.ts";

const SHA = "a".repeat(40);
const config = parseConfig({ ...REQUIRED_ENV, PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
// starts without it — and G24 resolves the unit's quota against it while the gates run.
beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

/** The manifest the consumer fixtures onboard: one declared build, so gate G18's manifest half holds. */
const CONSUMER_MANIFEST: ConsumerManifest = {
  apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", mongodb: "shared" as const,
  name: "acme", owner: "team-acme", envs: ["prod"],
  chart: { path: "deploy/chart" }, services: [], databases: [], keyPatterns: [], channelPatterns: [], secrets: [],
  builds: [{ name: "acme-api", containerfile: "Containerfile" }],
};
/** The chart's per-stage pin G18's chart half reads — the builds[] entry whose `image` is the build
 *  name, i.e. the key the release pipeline's bump task writes the tag into. */
const CHART_PINS = 'builds:\n  - name: acme-api\n    image: acme-api\n    tag: "0.0.0-placeholder"\n';

function passReport(): GateReport {
  return {
    contractVersion: "1.5", runnerVersion: "t", repoURL: "https://github.com/x/acme.git",
    requestedRef: "main", resolvedSha: SHA, startedAt: 1, finishedAt: 2, manifest: CONSUMER_MANIFEST,
    dependencies: [], gates: [{ id: "G1", title: "m", severity: "hard", status: "pass", expected: "x", found: "y", reason: null, detail: "ok" }],
    verdict: "pass", reportHash: "h",
    sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true },
  };
}

const fakeSeeder = () => ({ seed: async () => ({ created: true }), patchApp: async () => {}, seedPostgres: async () => ({ created: true }), seedMongodb: async () => ({ created: true }), seedBuildRepoPat: async () => ({ created: true }), refreshBuildRepoPat: async () => {}, deleteBuildRepoPat: async () => {}, deleteApp: async () => {}, deletePostgres: async () => {}, deleteMongodb: async () => {}, seedTenantCrypto: async () => ({ created: true }), deleteTenantCrypto: async () => {} });


/** A FakePlatformRepo whose cluster values chain carries `global.unitApex` for the two consumer
 *  fixtures' domains — onboard's planStream resolves OnboardParams.unitApex from exactly this chain
 *  (admission-policy.ts unitApexFromChain), and the fake's own default chain does not state it. Seeded
 *  directly (not via fetchResetBranch) so the fake's lazy default-chain seed never overwrites it. */
function seededPlatformRepo(): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  for (const domain of ["s1.example", "s2.example"]) {
    repo.seed(domain, "clusters/platform/values-common.yaml", "global:\n  timezone: Europe/Amsterdam\n");
    for (const stage of ["dev", "test", "prod"]) repo.seed(domain, `clusters/platform/values-${stage}.yaml`, `global:\n  env: ${stage}\n`);
    repo.seed(domain, clusterMapPath(domain), `global:\n  unitApex: example.com\n  endpoints:\n    vault:\n      url: https://vault.${domain}:8200\n`);
  }
  return repo;
}

/** The maps a build-plane read goes through. The routes under test never reach setup-webhook, so this
 *  serves the port's shape rather than an assertion. */
const resolveBuildPlaneFqdn = seedClusterMaps(new FakePlatformRepo(), { "s1.example": "prod", "s2.example": "dev" });

function onboardPorts(): OnboardPorts {
  const lifecycle = lifecyclePorts();
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/chart/values-prod.yaml": CHART_PINS } }),
    runner: new FakeGateRunner({ report: passReport() }),
    registrations: lifecycle.registrations,
    channelStages: async () => CHANNEL_STAGES,
    resolveBuildPlaneFqdn,
    seeder: fakeSeeder(),
    // Reuse the lifecycle resolver so onboard drives the same master-local fakes.
    resolver: lifecycle.resolver,
    tenantSubdomains: async () => [], dns: emptyZone(),
    declareListening: true,
    argoWatchTimeoutMs: 1000,
    deployRefVisibleMs: 100,
    releaseBuildAppearMs: 100,
    releasePollIntervalMs: 1,
  };
}

function lifecyclePorts(): LifecyclePorts {
  return {
    registrations: new Registrations(seededPlatformRepo()),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } }),
      argoReader: new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } }),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000,
  };
}

async function make(onboardingEnabled: boolean, resolver?: FakeClusterKubeResolver, githubApp?: FakeGitHubApp): Promise<{ app: Hono<AppEnv>; executor: Executor; cookie: string; store: CredentialStore }> {
  const store = new CredentialStore({ db: db.db, logger, ...(githubApp ? { githubApp } : {}) });
  const bus = new RunEventBus();
  const lc = lifecyclePorts();
  const extra = onboardingEnabled
    ? [makeOnboardDef(onboardPorts()), makeOffboardDef({ ...lc, seeder: fakeSeeder() }), makeSuspendDef(lc), makeResumeDef(lc)]
    : [];
  const executor = new Executor({ db: db.db, creds: store, bus, logger, runDefinitions: buildRunDefinitions({ db: db.db }, extra), sshFactory: noSsh, actor: () => "op_system" });
  const session = new SessionCodec(db.db, config);
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    // The live reconciliation read (GET /api/consumers/:id/live) reads the cluster + ArgoCD through
    // the resolver; when absent (or onboarding disabled) it degrades to SQL-only.
    registerProtected: (a) => registerConsumerRoutes(a, { executor, db: db.db, store, onboardingEnabled, github: new FakeGitHubConsumer(), ...(resolver ? { resolver } : {}), ...(githubApp ? { githubApp } : {}) }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, executor, cookie, store };
}

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

// The base seed: the master server (m1) with its self-cluster cls_1. Historically the sole
// cluster of these tests, so the consumer/tenant rows below all live on it.
function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
}

// A slave-hosted cluster next to the master self-cluster — the target-picker tests seed both to
// prove both pickers offer the clusters whose server carries the slave part, and not the pure master.
function seedSlaveCluster(): void {
  db.db.insert(servers).values({ id: "srv_2", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", name: "s2", status: "active" }).run();
}

const RAW_PAT = "github_pat_raw_secret_value";
// {channel} — the onboard TRIGGERS the release at the next version after the repo's release tags; the request carries
// no version, no ref, no tag — and no credential: the unit's identity is its owner's (#220), recorded once.
const REQ = { consumerName: "acme", repoURL: "https://github.com/x/acme.git", channel: "stable", stage: "prod", clusterId: "cls_1", owner: "team" };

/** Records an owner's identity with REAL sealed rows of the store under test: its packages
 *  reader always, its repository PAT where `repoPat` is given (the App does not reach it). */
async function recordOwner(store: CredentialStore, org: string, o: { repoPat?: string } = {}): Promise<void> {
  dropCredentialRows(db.db, { kind: "owner", id: org });
  await store.seal({ kind: "pat", label: `packages reader (${org})`, plaintext: Buffer.from(`ghp_packages_${org}`), fingerprint: `sha256:pkg-${org}`, subject: { kind: "owner", id: org }, purpose: "packages-reader" });
  if (o.repoPat) await store.seal({ kind: "pat", label: `repository PAT (${org})`, plaintext: Buffer.from(o.repoPat), fingerprint: `sha256:pat-${org}`, subject: { kind: "owner", id: org }, purpose: "repository-pat" });
}

describe("consumer API", () => {
  it("501 NOT_CONFIGURED on onboard when onboarding is not wired", async () => {
    const { app, cookie } = await make(false);
    const res = await app.request("/api/consumers", { method: "POST", ...authed(cookie), body: JSON.stringify(REQ) });
    expect(res.status).toBe(501);
  });

  it("onboard: 201 + runId, and the run reaches planned", async () => {
    seedCluster();
    const { app, executor, cookie, store } = await make(true);
    await recordOwner(store, "x", { repoPat: RAW_PAT });
    const res = await app.request("/api/consumers", { method: "POST", ...authed(cookie), body: JSON.stringify(REQ) });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    expect(runId).toMatch(/^run_/);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned"); // validation passed against the fakes
  });

  it("404 on the deploy and promote routes — the manager does not deploy; a release reaches a stage through its own pipeline", async () => {
    seedCluster();
    const { app, cookie } = await make(true);
    for (const path of ["/api/consumers/acme/deploy", "/api/consumers/acme/promote"]) {
      const res = await app.request(path, { method: "POST", ...authed(cookie), body: JSON.stringify({ release: "1.0.0-stable-20260719120000", stages: ["prod"], targetClusterIds: ["cls_1"] }) });
      expect(res.status).toBe(404);
    }
  });

  it("400 on an invalid onboard body", async () => {
    const { app, cookie } = await make(true);
    const res = await app.request("/api/consumers", { method: "POST", ...authed(cookie), body: JSON.stringify({ consumerName: "acme" }) });
    expect(res.status).toBe(400);
  });

  // The rule (#220): the unit's identity is its owner's — the App where its installation
  // reaches the repository (a credential row storing nothing), the owner's repository PAT
  // where it does not (sealed again under the unit's name), a refusal naming the page else; and the
  // owner's packages reader is required whichever reads.
  it("onboards a repository the GitHub App reaches under the App, one it does not under the owner's repository PAT, and refuses one whose owner records no repository PAT", async () => {
    seedCluster();
    const githubApp = new FakeGitHubApp();
    const { app, executor, cookie, store } = await make(true, undefined, githubApp);
    await recordOwner(store, githubApp.org);
    const res = await app.request("/api/consumers", { method: "POST", ...authed(cookie), body: JSON.stringify({ ...REQ, repoURL: `https://github.com/${githubApp.org}/acme.git` }) });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    await executor.settle(runId);
    const params = JSON.parse((db.sqlite.prepare("SELECT params_json FROM runs WHERE id = ?").get(runId) as { params_json: string }).params_json) as { repoCredentialId: string };
    // The App's ONE row, the owner's (recordTestOwners seeds it as boot does) — no row of the unit's (#226).
    const chosen = (await store.list({ kind: "github-app" })).find((c) => c.id === params.repoCredentialId);
    expect(chosen?.subject).toEqual({ kind: "owner", id: ORG }); // the App's one row, seeded for the fixture's owner as boot seeds it
    // A repository outside the installation whose owner records no repository PAT is refused naming both halves.
    dropCredentialRows(db.db, { kind: "owner", id: "x" });
    await recordOwner(store, "x");
    const outside = await app.request("/api/consumers", { method: "POST", ...authed(cookie), body: JSON.stringify(REQ) });
    expect(outside.status).toBe(400);
    expect(await outside.text()).toContain("does not reach x/acme, and owner x records no repository PAT");
    // With the owner's repository PAT recorded it is onboarded with THAT row — the owner's, never a copy of it (#226).
    await recordOwner(store, "x", { repoPat: RAW_PAT });
    const withPat = await app.request("/api/consumers", { method: "POST", ...authed(cookie), body: JSON.stringify(REQ) });
    expect(withPat.status).toBe(201);
    const second = JSON.parse((db.sqlite.prepare("SELECT params_json FROM runs WHERE id = ?").get(((await withPat.json()) as { runId: string }).runId) as { params_json: string }).params_json) as { repoCredentialId: string };
    const row = (await store.list({ kind: "pat" })).find((c) => c.id === second.repoCredentialId);
    expect([row?.label, row?.subject, row?.purpose]).toEqual(["repository PAT (x)", { kind: "owner", id: "x" }, "repository-pat"]);
    expect((await store.open(second.repoCredentialId, { purpose: "test:assert-sealed" })).toString("utf8")).toBe(RAW_PAT);
    // An owner recording nothing at all, not reached by the App, is refused naming the repository PAT and the page.
    dropCredentialRows(db.db, { kind: "owner", id: "x" });
    const none = await app.request("/api/consumers", { method: "POST", ...authed(cookie), body: JSON.stringify({ ...REQ, consumerName: "acme3" }) });
    expect(none.status).toBe(400);
    expect(await none.text()).toContain("owner x records no repository PAT");
  });

  it("a PAT in the request body is ignored — params_json carries ONLY the sealed reference of the owner's identity, never a value", async () => {
    seedCluster();
    const { app, executor, cookie, store } = await make(true);
    await recordOwner(store, "x", { repoPat: RAW_PAT });
    const res = await app.request("/api/consumers", { method: "POST", ...authed(cookie), body: JSON.stringify({ ...REQ, repoPat: "github_pat_stray" }) });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    await executor.settle(runId);
    const runRow = db.sqlite.prepare("SELECT params_json FROM runs WHERE id = ?").get(runId) as { params_json: string };
    const params = JSON.parse(runRow.params_json) as { repoCredentialId?: string; repoPat?: string };
    expect(params.repoCredentialId).toMatch(/^cred_/);
    expect(params.repoPat).toBeUndefined();
    expect(runRow.params_json).not.toContain(RAW_PAT);
    expect(runRow.params_json).not.toContain("github_pat_stray");
    expect(await store.list({ subject: { kind: "unit", id: "acme" } })).toEqual([]); // the stray value sealed nothing, and no row is the unit's (#226)
  });

  it("lists onboarded consumers with their cluster", async () => {
    seedCluster();
    db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", host: "acme", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();
    const { app, cookie } = await make(true);
    const rows = (await (await app.request("/api/consumers", authed(cookie))).json()) as Array<{ name: string; domain: string; provenance: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "acme", domain: "s1.example", provenance: "manager" });
  });

  it("targets lists the active clusters whose server carries the slave part — the master among them", async () => {
    seedCluster(); // cls_1 on srv_1, role "master": carries the slave part from its own installation
    seedSlaveCluster(); // cls_2 on srv_2, role "slave"
    const { app, cookie } = await make(true);
    const rows = (await (await app.request("/api/consumers/targets", authed(cookie))).json()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["cls_1", "cls_2"]);
  });

  it("offboard: 201 + runId for an existing consumer", async () => {
    seedCluster();
    db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", host: "acme", provenance: "manager", status: "active" }).run();
    const { app, cookie } = await make(true);
    const res = await app.request("/api/consumers/app_1/offboard", { method: "POST", ...authed(cookie), body: "{}" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { runId: string }).runId).toMatch(/^run_/);
  });

  // The per-consumer LIVE reconciliation read (GET /api/consumers/:appId/live) has its own suite in
  // api-consumer-live.test.ts, beside its tenant twin api-tenant-live.test.ts — this file is past the
  // 400-line budget, and the drift math needs the three-source Application fixture.
});

// ---- Tenant (multi-app) API ----

const TGUID = "zsjs023ctne0"; // a live-shaped throwaway guid (matches the tenants/** path guard)
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";

// A schema-valid catalog fan-out manifest + a clean render (Namespace + Tenant CR only at
// cluster scope) — the same shape create-tenant.run.test.ts validates green against the fakes.
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
${TEMPLATE_SPEC}  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true, namespaceLabels: { platform/redis-consumer: "true" } }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;
const tdoc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${TGUID}`, raw: { kind }, ...over,
});
// No Tenant CR document: the Manager provisions that object itself (provision-tenant-cr), and the
// T3 isolation gate now refuses a chart that renders one (CLUSTER_SCOPED_FORBIDDEN includes "Tenant").
const CLEAN_DOCS: RenderedDoc[] = [
  tdoc("Namespace", { namespace: "", raw: { kind: "Namespace" } }),
  tdoc("Deployment"),
];

// A resolver whose master path yields fresh master-local fakes + argoNamespace "argocd".
function tenantResolver(): FakeClusterKubeResolver {
  return new FakeClusterKubeResolver({
    clusterReader: new FakeClusterReader({ deployState: { domain: "s2.example", stage: "prod", writtenAt: "x", generation: 1 } }),
    argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
  });
}

function tenantOnboardPorts(reg: TenantRegistrations): TenantOnboardPorts {
  return withAppsTemplate({
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML, ...APP_OVERLAYS } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations: reg,
    resolver: tenantResolver(),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: "https://github.com/x/hostyour-cloud.git",
    argoWatchTimeoutMs: 1000,
    // ensure-images defaults: every image present ⇒ the step is a pure probe/no-op here.
    registryProbe: new FakeRegistryProbe(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }],
    consumerHostLabels: async () => [], dns: emptyZone(),
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: zot.m1.example\n` }],
  });
}

function tenantLifecyclePorts(reg: TenantRegistrations): TenantLifecyclePorts {
  return { registrations: reg, resolver: tenantResolver(), catalogRepoUrl: DEPLOY_URL, argoWatchTimeoutMs: 1000, resolveUnitApex: async () => "example.com" };
}

async function makeTenant(enabled: boolean): Promise<{ app: Hono<AppEnv>; executor: Executor; cookie: string }> {
  const store = new CredentialStore({ db: db.db, logger });
  const bus = new RunEventBus();
  const reg = new TenantRegistrations(new FakePlatformRepo());
  const defs = enabled
    ? [
        makeCreateTenantDef(tenantOnboardPorts(reg)),
        makeAddAppDef(tenantOnboardPorts(reg)),
        makeRemoveAppDef(tenantLifecyclePorts(reg)),
        makeSuspendTenantDef(tenantLifecyclePorts(reg)),
        makeResumeTenantDef(tenantLifecyclePorts(reg)),
        makeOffboardTenantDef(tenantLifecyclePorts(reg)),
      ]
    : [];
  const executor = new Executor({ db: db.db, creds: store, bus, logger, runDefinitions: buildRunDefinitions({ db: db.db }, defs), sshFactory: noSsh, actor: () => "op_system" });
  const session = new SessionCodec(db.db, config);
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerTenantRoutes(a, { executor, db: db.db, onboardingEnabled: enabled }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, executor, cookie };
}

// Seed a live tenant row + one app row on the seeded cluster (for the read + synchronous lifecycle
// routes). Reuses seedCluster (srv_1 + cls_1 @ s1.example/prod, tier rehearsal).
function seedTenant(): void {
  seedCluster();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: TGUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", provenance: "manager", status: "active" }).run();
  db.db.insert(tenantApps).values({ id: "tna_1", tenantId: "tnt_1", name: "erp" }).run();
}

// The request targets the seeded slave cls_2. resolveCluster is role-agnostic — it requires only
// an ACTIVE cluster — so the slave here is test topology, not an enforced law.
const CREATE_REQ = { clusterId: "cls_2", stage: "prod", subdomain: "acme", owner: "team-acme", apps: [{ name: "erp" }] };

describe("tenant API", () => {
  it("501 NOT_CONFIGURED on create-tenant when tenant onboarding is not wired", async () => {
    const { app, cookie } = await makeTenant(false);
    const res = await app.request("/api/tenants", { method: "POST", ...authed(cookie), body: JSON.stringify(CREATE_REQ) });
    expect(res.status).toBe(501);
  });

  it("create-tenant: 201 + runId, and the run reaches planned", async () => {
    seedSlaveCluster(); // the tenant targets the seeded slave (cls_2); resolveCluster requires it to be ACTIVE
    const { app, executor, cookie } = await makeTenant(true);
    const res = await app.request("/api/tenants", { method: "POST", ...authed(cookie), body: JSON.stringify(CREATE_REQ) });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    expect(runId).toMatch(/^run_/);
    await executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("planned"); // T1..T4 fan-out gates passed against the fakes
  });

  it("400 on an invalid create-tenant body", async () => {
    const { app, cookie } = await makeTenant(true);
    const res = await app.request("/api/tenants", { method: "POST", ...authed(cookie), body: JSON.stringify({ subdomain: "acme" }) });
    expect(res.status).toBe(400);
  });

  it("lists onboarded tenants with their cluster", async () => {
    seedTenant();
    const { app, cookie } = await makeTenant(true);
    const rows = (await (await app.request("/api/tenants", authed(cookie))).json()) as Array<{ guid: string; domain: string; provenance: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guid: TGUID, domain: "s1.example", stage: "prod", provenance: "manager" });
  });

  it("returns one tenant with its per-app rows", async () => {
    seedTenant();
    const { app, cookie } = await makeTenant(true);
    const body = (await (await app.request("/api/tenants/tnt_1", authed(cookie))).json()) as { guid: string; apps: Array<{ name: string }> };
    expect(body.guid).toBe(TGUID);
    expect(body.apps.map((a) => a.name)).toEqual(["erp"]);
  });

  it("404 for an unknown tenant", async () => {
    const { app, cookie } = await makeTenant(true);
    const res = await app.request("/api/tenants/tnt_missing", authed(cookie));
    expect(res.status).toBe(404);
  });

  it("targets lists the active clusters whose server carries the slave part — the same list the consumer picker offers", async () => {
    seedCluster(); // cls_1 on the master (srv_1, role "master"): no slave tier
    seedSlaveCluster(); // cls_2 on srv_2 (role "slave")
    const { app, cookie } = await makeTenant(true);
    const rows = (await (await app.request("/api/tenants/targets", authed(cookie))).json()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["cls_1", "cls_2"]);
  });

  it("targets filters on cluster STATUS beside the role: a rebuilding slave is not offered", async () => {
    seedCluster();
    seedSlaveCluster();
    db.db.update(clusters).set({ status: "rebuilding" }).where(eq(clusters.id, "cls_2")).run();
    const { app, cookie } = await makeTenant(true);
    const rows = (await (await app.request("/api/tenants/targets", authed(cookie))).json()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["cls_1"]);
  });

  it("tenant-suspend: 201 + runId for an existing tenant", async () => {
    seedTenant();
    const { app, cookie } = await makeTenant(true);
    const res = await app.request("/api/tenants/tnt_1/suspend", { method: "POST", ...authed(cookie), body: "{}" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { runId: string }).runId).toMatch(/^run_/);
  });

  it("remove-app: 201 + runId dropping one app of the matrix", async () => {
    seedTenant();
    const { app, cookie } = await makeTenant(true);
    const res = await app.request("/api/tenants/tnt_1/apps/erp/remove", { method: "POST", ...authed(cookie), body: "{}" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { runId: string }).runId).toMatch(/^run_/);
  });

  it("400 on an add-app with an invalid app name", async () => {
    seedTenant();
    const { app, cookie } = await makeTenant(true);
    const res = await app.request("/api/tenants/tnt_1/apps", { method: "POST", ...authed(cookie), body: JSON.stringify({ app: "Not A Name!" }) });
    expect(res.status).toBe(400);
  });
});

