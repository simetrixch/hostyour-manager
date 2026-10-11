import { beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import type { DbHandle } from "../../db/client.ts";
import { openUnitDb } from "#unit/server/plugin.fixture.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeAddAppDef, AddAppParams, type AddAppPorts } from "./add-app.run.ts";
import { FakePublicProbe } from "#unit/server/adapters/http-probe/testing/fake.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { memberApplication } from "./tenant-fanout.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { TenantRegistrationSchema, type TenantValidationReport } from "../../../shared/tenant.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import { testMembers, APP_OVERLAYS, TEST_BUNDLE, TEST_CHANNEL_STAGES } from "./tenant-members.fixture.ts";
import { bundleReleaseTag } from "./engine-line.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { TEMPLATE_SPEC, withAppsTemplate, recordTestOwners } from "./tenant-apps-repo.fixture.ts";

// The live tenant, the ports and the step contexts every add-app test stands on.

export const SHA = "a".repeat(40);
export const GUID = "zsjs023ctne0";
const DEPLOY_URL = "https://github.com/acme/acme-deploy.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
export const NEW_APP = "crm";
const EXPECTED = [memberApplication(GUID, NEW_APP, "prod")];
// The registry host the ports fixture resolves for the tenant's cluster — in the default topology
// the build plane is the master, so the fixture answers zot on m1.example.
export const REGISTRY_HOST = "zot.m1.example";

/** A cluster-marking resolver that answers every cluster short name at "prod" — every fixture in this
 *  file lands its tenant on s1/prod, so a single-stage stand-in is all TenantRegistrations needs to
 *  satisfy commitTenant's stage boundary check. */

export const MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: deploy
owner: platform
envs: [dev, prod]
builds:
  - name: engine
    containerfile: Containerfile
tenant:
  members:
    - { name: auth, path: /auth, chart: charts/example-auth, identityProvider: true, namespaceLabels: { platform/redis-consumer: "true" } }
    - { name: jobs, path: /jobs, chart: charts/example-jobs }
    - { name: report, path: /reports, chart: charts/example-report }
  reservedMemberNames: [api, ws, health, tenant, admin, app]
${TEMPLATE_SPEC}  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;

export const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}-${NEW_APP}`, raw: { kind }, ...over,
});
export const NS_DOC = doc("Namespace", { namespace: "", raw: { kind: "Namespace" } });
// No Tenant doc here — the Tenant CR is provisioned by the Manager, never rendered by a chart, so a
// clean fan-out never carries one (T3 forbids it, same as any other cluster-scoped kind).
export const CLEAN_DOCS = [NS_DOC, doc("Deployment")];

export let db: DbHandle;
/** A fresh in-memory database per test, the one every helper here reads; a test file calls this once.
 *  The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
 *  starts without it — and write-pointer resolves the tenant's ceiling against it. */
export function useMemoryDb(): void {
  beforeEach(() => { db = openUnitDb(); recordTestOwners(db.db); });
  afterEach(() => { db.sqlite.close(); });
}

function passReport(): TenantValidationReport {
  return composeTenantReport({
    resolvedSha: SHA, probeGuid: GUID, appsValidated: ["erp"], resolvedMembers: ["auth", "jobs", "report"],
    startedAt: 1, finishedAt: 2, manifest: null,
    gates: [{ id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" }],
  });
}

function syncedStatuses(names: readonly string[], ref: string): Map<string, ArgoAppStatus> {
  const m = new Map<string, ArgoAppStatus>();
  for (const n of names) m.set(n, { syncRevision: ref, targetRevision: null, sync: "Synced", health: "Healthy" });
  return m;
}

function repoWithManifest(resolvedSha = SHA): FakeRepoReader {
  return new FakeRepoReader({ resolvedSha, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML, ...APP_OVERLAYS } });
}

/** The TEMPLATE's apps.yaml as the fixture scripts it: the standing "erp", "web", and the new app,
 *  each with the two seed selections — what every tenant's "Add app" is judged against (#215). */
export const TEMPLATE_APPS = (extra = ""): Record<string, string> => ({
  "apps.yaml": `apps:\n${["erp", "web", NEW_APP].map((name) => `  - name: ${name}\n    title: ${name.toUpperCase()}\n    selections:\n      seedReference: { title: "Reference data", default: false }\n      seedDemo: { title: "Demo data", default: false }\n${name === NEW_APP ? extra : ""}`).join("")}`,
  [`apps/${NEW_APP}/package.json`]: "{}\n",
});

/** A FakePlatformRepo pre-seeded with a live tenant carrying one app ("erp") — the registration file a
 *  create-tenant run would have committed, so add-app's readTenant folds it back correctly. */
export function seededPlatformRepo(bundle: { appsRepo?: string; appsImage?: string; appsImageTag?: string } = TEST_BUNDLE): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme",
    members: testMembers([{ name: "erp" }]), identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"), ...bundle,
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return repo;
}

// The kube clients ride behind the resolver now: fold the per-test fakes (argo/cluster/
// projects) into a FakeClusterKubeResolver whose master path resolves to argoNamespace "argocd".
type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

/** A tenant's own bundle as the reader finds it at the release its standing tag was built from. */
export function scriptBundle(prt: Pick<AddAppPorts, "repo">, files: Record<string, string>, repoURL: string = TEST_BUNDLE.appsRepo): void {
  (prt.repo as FakeRepoReader).scriptFor(`${repoURL}@${bundleReleaseTag(TEST_BUNDLE.appsImageTag)}`, { resolvedSha: SHA, files });
}

export function ports(over: Partial<AddAppPorts> & FakeKube = {}, template: Record<string, string> = TEMPLATE_APPS()): AddAppPorts {
  const { argo, cluster, projects, ...portOver } = over;
  return withAppsTemplate({
    repo: repoWithManifest(),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations: new TenantRegistrations(seededPlatformRepo()),
    probe: new FakePublicProbe({}),
    answerWaitMs: 0,
    answerPollMs: 0,
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader({
        deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 },
        smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "crm-engine", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
      }),
      argoReader: argo ?? new FakeMasterArgoReader({ statuses: syncedStatuses(EXPECTED, SHA) }),
      projectWriter: projects ?? new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    deployRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: ${REGISTRY_HOST}\n` }],
    // ensure-images defaults: every image present ⇒ the step is a pure probe/no-op, so the
    // existing suites never trigger a build.
    registryProbe: new FakeRegistryProbe(),
    buildRbac: new FakeBuildRbacWriter(),
    channelStages: async () => TEST_CHANNEL_STAGES,
    attestedBuilds: async () => [
      { unit: "example-platform", build: "example-engine" },
      { unit: "swissbookai", build: "swissbookai-api" },
    ],
    consumerHostLabels: async () => ["example-platform", "swissbookai"],
    // The Password field key the new app's engine reads (seed-password-field-key); every write is
    // a first one here, as it is for an app that never stood in the tenant.
    seeder: { seedTenantAppKey: async () => ({ created: true }) } as unknown as NonNullable<AddAppPorts["seeder"]>,
    ...portOver,
  }, template);
}

export function params(over: Partial<AddAppParams> = {}): AddAppParams {
  return AddAppParams.parse({
    tenantId: "tnt_1", guid: GUID, stage: "prod", clusterId: "cls_1", domain: "s1.example",
    cluster: "s1", registryHost: REGISTRY_HOST,
    chartsRef: SHA, app: NEW_APP, member: testMembers([NEW_APP])[3]!, report: passReport(), expectedApps: EXPECTED,
    deployRepoUrl: DEPLOY_URL,
    ...over,
  });
}

export function ctx(p: AddAppParams, stepName: string, logs: string[]): StepCtx {
  return {
    runId: "run_add", stepName, db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal,
    logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

export function planCtx(): PlanStreamCtx {
  return { db: db.db, log: () => undefined, signal: new AbortController().signal };
}

// The tenant's own slave and the live tenant row on it — everything add-app's planStream resolves
// against (loadTenantCluster + the registration; the registry host comes off the ports resolver).
export function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth" }).run();
  db.db.insert(tenantApps).values({ id: "tna_1", tenantId: "tnt_1", name: "erp" }).run();
}

export async function runAll(p: AddAppParams, prt: AddAppPorts, logs: string[]): Promise<void> {
  for (const step of makeAddAppDef(prt).steps(p)) await step.run(ctx(p, step.name, logs));
}
