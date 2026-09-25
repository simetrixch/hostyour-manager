// The tenant's own apps bundle through the tenant-create run: the plan DERIVES it for a tenant with
// an app — the repository `<org>/<bundle>-<subdomain>` and the image `<bundle>-<subdomain>` — and refuses
// without the GitHub App or the catalog's template; the apps-repo steps stand between the platform
// build units and seed-tenant-crypto; the bundle is never a build unit and asks no PAT; the render is
// handed the bundle at the placeholder and, after the build, at the tag the release stated; and the
// registration carries the three facts after one execute pass — or the empty pair for a tenant
// without an app.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { seedUnitSizes } from "#unit/server/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { buildUnitStepName, refreshImagesStep, type TenantBuildRuntime } from "./tenant-builds.ts";
import { writeRegistrationStep } from "./create-tenant-registration.ts";
import { validateTenant } from "./validate-tenant.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { memberNamespace, tenantApplicationSet } from "./tenant-fanout.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { ports as onboardPorts, type FakeSeeder } from "./onboard.fixture.ts";
import { FakeRepoReader, FakePlatformRepo, FakeRepoWriter } from "../../adapters/git/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import type { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import { FakeObjectStore } from "../../adapters/object-store/testing/fake.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { RoleBindingManifest } from "../../adapters/kube/port.ts";
import { unitBuildNamespace } from "#unit/server/build-rbac.ts";
import type { TenantValidationReport } from "../../../shared/tenant.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";
import { APP_OVERLAYS, STANDING_MEMBER_NAMES as TEST_MEMBERS, TEST_BUNDLE, testMembers } from "./tenant-members.fixture.ts";
import { ORG, PLACEHOLDER_TAG as PLACEHOLDER, SHA, TEMPLATE_MANIFEST, TEMPLATE_SPEC, TEMPLATE_URL, TENANT_URL, UNIT, withAppsTemplate, recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

const GUID = "zsjs023ctne0";
const HOST = "zot.m1.example";
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
const APPS = [{ name: "erp" }];
const BUILT_TAG = "0.1.0-stable-20260202000000-def5678";
const APPS_REPO_STEPS = ["create-repository", "write-tree", "onboard-build-only"];
const catalogManifest = (spec: string): string => `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: catalog
owner: platform
envs: [dev, prod]
builds:
  - name: engine
    containerfile: Containerfile
tenant:
${spec}  buildRepos:
    - repo: https://github.com/acme/example-platform.git
      builds: [example-engine]
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui }
`;
const MANIFEST_YAML = catalogManifest(TEMPLATE_SPEC);
const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}`, raw: { kind }, ...over,
});
/** What the engine chart renders once the delivered `tenant.appsImage`/`appsImageTag` are composed
 *  into the app-fetch initContainer's image — the render the fake stands in for. */
const withBundle = (tag: string): RenderedDoc[] => [
  doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }),
  doc("Deployment", {
    raw: { kind: "Deployment", spec: { template: { spec: {
      containers: [{ name: "engine", image: `${HOST}/example-engine:0.4.0` }],
      initContainers: [{ name: "app-fetch", image: `${HOST}/${UNIT}:${tag}` }],
    } } } },
  }),
];
const CHAIN = [{ path: clusterMapPath("m1.example"), content: `global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: ${HOST}\n` }];

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

function passReport(): TenantValidationReport {
  return composeTenantReport({
    resolvedSha: SHA, probeGuid: GUID, appsValidated: ["erp"], resolvedMembers: ["auth", "jobs", "report", "erp"],
    startedAt: 1, finishedAt: 2, manifest: null,
    gates: [{ id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" }],
  });
}
function fakeTenantSeeder(): VaultSeeder {
  const no = () => Promise.reject(new Error("a tenant run never seeds a consumer entry"));
  return {
    seed: no, patchApp: no, seedPostgres: no, seedMongodb: no, seedBuildRepoPat: no, refreshBuildRepoPat: no,
    deleteBuildRepoPat: async () => {}, deleteApp: async () => {}, deletePostgres: async () => {}, deleteMongodb: async () => {},
    seedTenantCrypto: async () => ({ created: true }), deleteTenantCrypto: async () => {},
  };
}
/** The ports of a tenant WITHOUT the App and the template — what withAppsTemplate adds. */
function bare(over: Partial<TenantOnboardPorts> = {}, catalog = MANIFEST_YAML): TenantOnboardPorts {
  const dns = new FakeDnsProvider();
  return {
    seeder: fakeTenantSeeder(),
    objectStore: new FakeObjectStore(),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: catalog, ...APP_OVERLAYS } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: withBundle(PLACEHOLDER) } }),
    registrations: new TenantRegistrations(new FakePlatformRepo()),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({
        deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 },
        smoke: { namespaceExists: true, workloads: [], externalSecretsReady: true },
      }),
      argoReader: new FakeMasterArgoReader({ everyName: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } }),
      projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => CHAIN,
    registryProbe: new FakeRegistryProbe(),
    dns,
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }, { unit: UNIT, build: UNIT }],
    consumerHostLabels: async () => [],
    ...over,
  };
}
const ports = (over: Partial<TenantOnboardPorts> = {}, catalog = MANIFEST_YAML) => withAppsTemplate(bare(over, catalog));
function params(over: Partial<CreateTenantParams> = {}): CreateTenantParams {
  return CreateTenantParams.parse({
    guid: GUID, subdomain: "acme", stage: "prod", clusterId: "cls_1", domain: "s1.example",
    members: testMembers(APPS), identityProvider: "auth",
    cluster: "s1", chartsRef: SHA, registryHost: HOST,
    apps: APPS, seedUsers: false, quota: seedQuota("small"), owner: "team-acme",
    report: passReport(), expectedApps: tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], GUID, "prod"), catalogRepoUrl: DEPLOY_URL,
    ...over,
  });
}
/** A credential store shaped like the real one for the kind the apps-repo steps seal: a `github-app`
 *  credential opens to the token the App answers at THAT moment (security/store.ts mints it), every
 *  other kind to what was sealed. Records what it sealed. */
/** A credential store standing on the App's ONE row (#226), `cred_app`, which opens through the App. */
function fakeCreds(app?: FakeGitHubApp): { store: CredentialStore; seals: { id: string; kind: string; label: string; plaintext: string }[] } {
  const seals: { id: string; kind: string; label: string; plaintext: string }[] = [];
  const appRow = { id: "cred_app", kind: "github-app", label: `GitHub App (${app?.org ?? "acme-org"})`, fingerprint: "sha256:app", subject: { kind: "owner", id: app?.org ?? "acme-org" }, purpose: "repository-identity" };
  const store = {
    seal: async (i: { kind: string; label: string; plaintext: Buffer; fingerprint: string }) => {
      const id = `cred_${seals.length + 1}`;
      seals.push({ id, kind: i.kind, label: i.label, plaintext: i.plaintext.toString("utf8") });
      return { id, kind: i.kind, label: i.label, fingerprint: i.fingerprint };
    },
    open: async (id: string) => {
      if (id === appRow.id) {
        if (!app) throw new Error("the App's row opens through the App, and this store holds none");
        return Buffer.from(await app.installationToken(), "utf8");
      }
      const sealed = seals.find((x) => x.id === id);
      if (sealed?.kind === "github-app") {
        if (!app) throw new Error("a github-app credential opens through the App, and this store holds none");
        return Buffer.from(await app.installationToken(), "utf8");
      }
      return Buffer.from(sealed?.plaintext ?? "ghp_test", "utf8");
    },
    list: async ({ kind }: { kind: string }) => [appRow, ...seals.map(({ id, kind: k, label }) => ({ id, kind: k, label, fingerprint: "sha256:app", subject: { kind: "unit", id: "?" }, purpose: "repository-identity" }))].filter((x) => x.kind === kind),
  } as unknown as CredentialStore;
  return { store, seals };
}
function ctx(p: Record<string, unknown>, logs: string[], creds: CredentialStore = fakeCreds().store): StepCtx {
  return {
    runId: "run_bundle", stepName: "bundle", db: db.db, creds, params: p,
    secrets: { get: () => undefined, wipe: () => undefined },
    signal: new AbortController().signal, logger: {} as unknown as Logger,
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
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "5.6.7.8", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example", name: "m1", status: "active" }).run();
}
const REQUEST = { clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS };
async function planned(prt: TenantOnboardPorts, request: Record<string, unknown> = REQUEST) {
  const result = await makeCreateTenantDef(prt).planStream!(request, planCtx());
  if (result.outcome !== "planned") throw new Error(result.summary);
  return result;
}
async function refused(prt: TenantOnboardPorts, request: Record<string, unknown> = REQUEST): Promise<string> {
  const result = await makeCreateTenantDef(prt).planStream!(request, planCtx());
  if (result.outcome !== "rejected") throw new Error("planned");
  return result.summary;
}

describe("tenant-create planStream — the bundle derived, and the apps-repo steps between the build units and seed-tenant-crypto", () => {
  it("lists the platform build units, then create-repository, write-tree, onboard-build-only, then seed-tenant-crypto, in that order", async () => {
    seedClusters();
    const probe = new FakeRegistryProbe({ missing: ["example-engine:0.4.0"] });
    const result = await planned(ports({ registryProbe: probe, buildUnitRegistration: async (u) => (u === "example-platform" ? { form: "build-only", repoCredentialId: "cred_platform" } : null) }));
    const names = result.plan.steps.map((s) => s.name);
    const from = names.indexOf(buildUnitStepName("example-platform"));
    expect(from).toBeGreaterThan(names.indexOf("record-provisional"));
    expect(names.slice(from, from + 5)).toEqual([buildUnitStepName("example-platform"), ...APPS_REPO_STEPS, "seed-tenant-crypto"]);
    expect(names.indexOf("refresh-images")).toBe(names.indexOf("ensure-images") - 1);
    expect(names).toEqual(makeCreateTenantDef(ports()).steps(result.params).map((s) => s.name));
  });
  it("derives appsRepo and appsImage from the subdomain and the App's owner, freezes the unit's facts and never a tag, and names the repository and the apps in the summary", async () => {
    seedClusters();
    const result = await planned(ports());
    expect(result.params).toMatchObject({ appsRepo: TENANT_URL, appsImage: UNIT, appsUnit: { org: ORG, templateRepoURL: TEMPLATE_URL, templateBuild: "example-apps", registered: false } });
    expect("appsImageTag" in result.params).toBe(false);
    expect(result.plan.summary).toContain(`${ORG}/${UNIT}`);
    expect(result.plan.summary).toContain("erp");
    expect(result.plan.summary).toMatch(/^Onboard tenant/);
  });
  it("a zero-app tenant lists none of the three, derives nothing and needs no App", async () => {
    seedClusters();
    const result = await planned(bare({ helm: new FakeHelmRenderer({ fallback: { ok: true, docs: [] } }) }), { ...REQUEST, apps: [] });
    const names = result.plan.steps.map((s) => s.name);
    for (const step of APPS_REPO_STEPS) expect(names).not.toContain(step);
    expect(names).not.toContain("refresh-images");
    expect(result.params.appsRepo).toBeUndefined();
    expect(result.params.appsImage).toBeUndefined();
    expect(result.params.appsUnit).toBeUndefined();
  });
  it("refuses a tenant with an app when no GitHub App is wired, naming the three config keys", async () => {
    seedClusters();
    const summary = await refused(bare());
    for (const key of ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"]) expect(summary).toContain(key);
  });
  it("refuses a catalog that names no template, and one whose appsOrg is not the App's owner", async () => {
    seedClusters();
    expect(await refused(ports({}, catalogManifest("")))).toMatch(/declares no tenant\.appsBundle and tenant\.appsRepo/);
    const other = ports();
    other.githubApp.org = "other-org";
    expect(await refused(other)).toMatch(/tenant\.appsOrg is "acme-org" and the GitHub App is installed in "other-org"/);
  });
  it("refuses a subdomain whose apps unit is registered as DEPLOYABLE", async () => {
    seedClusters();
    expect(await refused(ports({ buildUnitRegistration: async (u) => (u === UNIT ? { form: "deployable" } : null) }))).toMatch(/registered as DEPLOYABLE/);
  });
  it("the bundle is NO build unit and asks NO PAT, even where the registry lacks it; it is rendered at the placeholder and left out of the probe", async () => {
    seedClusters();
    const probe = new FakeRegistryProbe({ missing: [`${UNIT}:${PLACEHOLDER}`] });
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: withBundle(PLACEHOLDER) } });
    const result = await planned(ports({ registryProbe: probe, helm }));
    expect(result.params.buildUnits).toEqual([]);
    expect(result.plan.requiredSecrets).toEqual([]);
    expect(result.params.requiredImages).toContainEqual({ repo: UNIT, tag: PLACEHOLDER });
    expect(probe.probes.some((key) => key.includes(UNIT))).toBe(false);
    expect(helm.requests.find((r) => r.namespace === memberNamespace(result.params.guid, "erp", "prod"))?.valuesObject).toMatchObject({ tenant: { appsImage: UNIT, appsImageTag: PLACEHOLDER } });
  });
  it("a bundle without the placeholder in the chain is refused by name", async () => {
    seedClusters();
    const prt = { ...ports(), resolveClusterValueFiles: async () => CHAIN };
    await expect(makeCreateTenantDef(prt).planStream!(REQUEST, planCtx())).rejects.toThrow(/global\.placeholderTag/);
  });
});

describe("tenant-create execute — one pass creates the repository, builds the bundle and registers it at the tag the release stated", () => {
  it("the registration carries appsRepo, appsImage and the PipelineRun's image-tag; the argo-sync grant names the unit", async () => {
    seedClusters();
    const buildPlane = new FakeBuildPlane();
    buildPlane.seedReleaseRun(UNIT, { runName: `${UNIT}-release-1`, releaseTag: "0.1.0-stable-20260202000000", succeeded: true, imageTag: BUILT_TAG });
    // The tenant's repository as the chain reads it back after write-tree: the manifest the run writes.
    const unitReader = new FakeRepoReader({ resolvedSha: SHA, files: {} });
    unitReader.scriptFor(TENANT_URL, { resolvedSha: SHA, files: { "deploy/platform.yaml": TEMPLATE_MANIFEST.replace(/example-apps/g, UNIT) } });
    const consumerRepo = new FakeRepoWriter();
    const onboard = onboardPorts({ repo: unitReader, consumerRepo, github: new FakeGitHubConsumer(), buildPlane });
    const buildRbac = new FakeBuildRbacWriter();
    const prt = ports({ onboard: () => ({ ports: onboard }), buildRbac });
    const result = await planned(prt);
    // After the build the render carries the bundle at the built tag, as the real chart would.
    (prt.helm as FakeHelmRenderer).setDocs(withBundle(BUILT_TAG));
    const logs: string[] = [];
    const creds = fakeCreds(prt.githubApp);
    prt.githubApp.token = "ghs_minted_for_this_pass";
    for (const step of makeCreateTenantDef(prt).steps(result.params)) await step.run(ctx(result.params, logs, creds.store));
    const entry = (await prt.registrations.readTenant("prod", result.params.guid))?.entry;
    expect(entry).toMatchObject({ appsRepo: TENANT_URL, appsImage: UNIT, appsImageTag: BUILT_TAG, apps: [{ name: "erp" }] });
    expect(prt.githubApp.created.map((c) => `${c.org}/${c.name}`)).toEqual([`${ORG}/${UNIT}`]);
    expect(Object.keys(consumerRepo.filesFor(TENANT_URL))).toContain("erp/package.json");
    // ONE github-app credential for the bundle, its id on the build registration; the seed, the
    // webhook and the dispatch each opened it to the token the App mints — nothing stored.
    expect(creds.seals).toEqual([]); // no row per unit (#226)
    expect((await onboard.registrations.readBuildRegistration(UNIT))?.entry).toMatchObject({ repoURL: TENANT_URL, builds: [UNIT] }); // no credential id on the entry (#226)
    expect((onboard.seeder as FakeSeeder).buildRepoPats).toEqual([{ consumerName: UNIT, pat: "ghs_minted_for_this_pass", packages: "ghp_test" }]); // the owner's packages reader opens to the store's fallback
    expect((onboard.github as FakeGitHubConsumer).created.map((c) => ({ repo: c.repo, token: c.token }))).toEqual([{ repo: UNIT, token: "ghs_minted_for_this_pass" }]);
    expect((onboard.github as FakeGitHubConsumer).dispatches.map((d) => ({ repo: d.repo, token: d.token }))).toEqual([{ repo: UNIT, token: "ghs_minted_for_this_pass" }]);
    expect(buildPlane.releaseWatches).toEqual([{ unit: UNIT, version: "0.1.0", channel: "stable" }]);
    expect(logs.some((l) => l.includes(`${UNIT}:${BUILT_TAG}`))).toBe(true);
    expect(logs.some((l) => l.includes(`${UNIT}: ${PLACEHOLDER} -> ${BUILT_TAG}`))).toBe(true);
    const binding = buildRbac.get("RoleBinding", "argocd", `${result.params.guid}-argo-sync`) as RoleBindingManifest | undefined;
    expect(binding?.subjects.map((s) => s.namespace)).toContain(unitBuildNamespace(UNIT));
  });
});

describe("validateTenant — the bundle is delivered under tenant: as the ApplicationSet delivers it", () => {
  const deps = (helm: FakeHelmRenderer) => ({ repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: catalogManifest(""), ...APP_OVERLAYS } }), helm, log: () => undefined, signal: new AbortController().signal });
  const base = { repoURL: DEPLOY_URL, ref: "main", stage: "prod" as const, apps: APPS, probeGuid: GUID, subdomain: "acme", clusterValueFiles: CHAIN };
  it("hands every member the image and the tag, and the empty pair to a tenant without one", async () => {
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [] } });
    await validateTenant({ ...base, appsImage: TEST_BUNDLE.appsImage, appsImageTag: TEST_BUNDLE.appsImageTag }, deps(helm));
    const engine = helm.requests.find((r) => r.namespace === memberNamespace(GUID, "erp", "prod"));
    expect(engine?.valuesObject).toMatchObject({ tenant: { appsImage: TEST_BUNDLE.appsImage, appsImageTag: TEST_BUNDLE.appsImageTag } });
    helm.requests.length = 0;
    await validateTenant({ ...base, apps: [] }, deps(helm));
    expect(helm.requests[0]?.valuesObject).toMatchObject({ tenant: { appsImage: "", appsImageTag: "" } });
  });
});

describe("refreshImagesStep — the fan-out rendered again with the tag the build read", () => {
  const refreshParams = (p: CreateTenantParams) => ({ guid: GUID, domain: "s1.example", stage: "prod" as const, subdomain: "acme", apps: APPS, seedUsers: false, registryHost: HOST, requiredImages: p.requiredImages, appsImage: p.appsImage });
  it("delivers the runtime's tag, and the re-read set carries the bundle at it", async () => {
    const runtime: TenantBuildRuntime = { appsImageTag: BUILT_TAG };
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: withBundle(BUILT_TAG) } });
    const p = params({ appsRepo: TENANT_URL, appsImage: UNIT, requiredImages: [{ repo: UNIT, tag: PLACEHOLDER }] });
    await refreshImagesStep(bare({ helm }), refreshParams(p), runtime).run(ctx(p, []));
    expect(helm.requests[0]?.valuesObject).toMatchObject({ tenant: { appsImage: UNIT, appsImageTag: BUILT_TAG } });
    expect(runtime.requiredImages).toContainEqual({ repo: UNIT, tag: BUILT_TAG });
  });
  it("refuses a pass with no tag in memory — a resume after onboard-build-only names the retry", async () => {
    const p = params({ appsRepo: TENANT_URL, appsImage: UNIT });
    await expect(refreshImagesStep(bare(), refreshParams(p), {}).run(ctx(p, []))).rejects.toThrow(/not in this pass's memory.*onboard-build-only/);
  });
});

describe("write-registration — the registration carries the bundle, or the empty pair", () => {
  const read = async (prt: TenantOnboardPorts) => (await prt.registrations.readTenant("prod", GUID))?.entry;
  it("carries appsRepo, appsImage and the tag the run read off the release", async () => {
    const prt = bare();
    await writeRegistrationStep(prt, params({ appsRepo: TENANT_URL, appsImage: UNIT }), { appsImageTag: BUILT_TAG }).run(ctx(params(), []));
    expect(await read(prt)).toMatchObject({ appsRepo: TENANT_URL, appsImage: UNIT, appsImageTag: BUILT_TAG });
  });
  it("a tenant without a bundle carries the empty pair and no repository — both keys stand for the appset's bare read", async () => {
    const prt = bare();
    await writeRegistrationStep(prt, params({ apps: [], members: testMembers([]), expectedApps: tenantApplicationSet(TEST_MEMBERS, GUID, "prod") }), {}).run(ctx(params(), []));
    const entry = await read(prt);
    expect(entry?.appsImage).toBe("");
    expect(entry?.appsImageTag).toBe("");
    expect(entry?.appsRepo).toBeUndefined();
  });
  it("refuses to name an image without a tag — the apps-repo steps did not run in this pass", async () => {
    await expect(writeRegistrationStep(bare(), params({ appsRepo: TENANT_URL, appsImage: UNIT }), {}).run(ctx(params(), []))).rejects.toThrow(/not in this pass's memory.*onboard-build-only/);
  });
});
