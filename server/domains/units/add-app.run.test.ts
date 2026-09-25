import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { seedUnitSizes } from "./unit-size.ts";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeAddAppDef, AddAppParams } from "./add-app.run.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { memberApplication, memberAppProject } from "./tenant-fanout.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo, FAKE_BOOKS_BRANCH } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { TenantRegistrationSchema, type TenantValidationReport } from "../../../shared/tenant.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import { testMembers, APP_OVERLAYS, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { TEMPLATE_SPEC, withAppsTemplate, ORG, recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import { buildUnitStepName } from "./tenant-builds.ts";

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
const NEW_APP = "crm";
const EXPECTED = [memberApplication(GUID, NEW_APP, "prod")];
// The registry host the ports fixture resolves for the tenant's cluster — in the default topology
// the build plane is the master, so the fixture answers zot on m1.example.
const REGISTRY_HOST = "zot.m1.example";

/** A cluster-marking resolver that answers every cluster short name at "prod" — every fixture in this
 *  file lands its tenant on s1/prod, so a single-stage stand-in is all TenantRegistrations needs to
 *  satisfy commitTenant's stage boundary check. */

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
${TEMPLATE_SPEC}  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;

const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}-${NEW_APP}`, raw: { kind }, ...over,
});
const NS_DOC = doc("Namespace", { namespace: "", raw: { kind: "Namespace" } });
// No Tenant doc here — the Tenant CR is provisioned by the Manager, never rendered by a chart, so a
// clean fan-out never carries one (T3 forbids it, same as any other cluster-scoped kind).
const CLEAN_DOCS = [NS_DOC, doc("Deployment")];

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
// starts without it — and write-pointer resolves the tenant's ceiling against it.
beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

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
const TEMPLATE_APPS = (extra = ""): Record<string, string> => ({
  "apps.yaml": `apps:\n${["erp", "web", NEW_APP].map((name) => `  - name: ${name}\n    title: ${name.toUpperCase()}\n    selections:\n      seedReference: { title: "Reference data", default: false }\n      seedDemo: { title: "Demo data", default: false }\n${name === NEW_APP ? extra : ""}`).join("")}`,
  [`${NEW_APP}/package.json`]: "{}\n",
});

/** A FakePlatformRepo pre-seeded with a live tenant carrying one app ("erp") — the registration file a
 *  create-tenant run would have committed, so add-app's readTenant folds it back correctly. */
function seededPlatformRepo(bundle: { appsRepo?: string; appsImage?: string; appsImageTag?: string } = TEST_BUNDLE): FakePlatformRepo {
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

function ports(over: Partial<TenantOnboardPorts> & FakeKube = {}, template: Record<string, string> = TEMPLATE_APPS()): TenantOnboardPorts {
  const { argo, cluster, projects, ...portOver } = over;
  return withAppsTemplate({
    repo: repoWithManifest(),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations: new TenantRegistrations(seededPlatformRepo()),
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader({
        deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 },
        smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "crm-engine", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
      }),
      argoReader: argo ?? new FakeMasterArgoReader({ statuses: syncedStatuses(EXPECTED, SHA) }),
      projectWriter: projects ?? new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: ${REGISTRY_HOST}\n` }],
    // ensure-images defaults: every image present ⇒ the step is a pure probe/no-op, so the
    // existing suites never trigger a build.
    registryProbe: new FakeRegistryProbe(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [
      { unit: "example-platform", build: "example-engine" },
      { unit: "swissbookai", build: "swissbookai-api" },
    ],
    consumerHostLabels: async () => ["example-platform", "swissbookai"],
    ...portOver,
  }, template);
}

function params(over: Partial<AddAppParams> = {}): AddAppParams {
  return AddAppParams.parse({
    tenantId: "tnt_1", guid: GUID, stage: "prod", clusterId: "cls_1", domain: "s1.example",
    cluster: "s1", registryHost: REGISTRY_HOST,
    chartsRef: SHA, app: NEW_APP, member: testMembers([NEW_APP])[3]!, report: passReport(), expectedApps: EXPECTED,
    catalogRepoUrl: DEPLOY_URL,
    ...over,
  });
}

function ctx(p: AddAppParams, stepName: string, logs: string[]): StepCtx {
  return {
    runId: "run_add", stepName, db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal,
    logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function planCtx(): PlanStreamCtx {
  return { db: db.db, log: () => undefined, signal: new AbortController().signal };
}

// The tenant's own slave and the live tenant row on it — everything add-app's planStream resolves
// against (loadTenantCluster + the registration; the registry host comes off the ports resolver).
function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth" }).run();
  db.db.insert(tenantApps).values({ id: "tna_1", tenantId: "tnt_1", name: "erp" }).run();
}

async function runAll(p: AddAppParams, prt: TenantOnboardPorts, logs: string[]): Promise<void> {
  for (const step of makeAddAppDef(prt).steps(p)) await step.run(ctx(p, step.name, logs));
}

describe("add-app run definition", () => {
  it("keeps attest-target first under `mutating` and refuses the synchronous plan() path", () => {
    const def = makeAddAppDef(ports());
    expect(def.mutating).toBe(true);
    expect(def.steps({} as AddAppParams).map((s) => s.name)).toEqual([
      "attest-target", "ensure-images", "apply-appproject", "provision-argo-sync", "append-app", "watch-sync-set", "smoke", "record-inventory",
    ]);
    expect(() => def.plan({} as AddAppParams, { db: db.db })).toThrow(/planStream/);
  });

  it("walking skeleton: a new app is appended to a live tenant green against the fakes", async () => {
    seedClusters();
    const prt = ports();
    const logs: string[] = [];
    await runAll(params(), prt, logs);

    // append-app appended the new app to the registration, keeping the existing app AND the cluster
    // field (drop-trap: the read-modify-write rewrite must not erase it).
    const read = await prt.registrations.readTenant("prod", GUID);
    expect(read?.entry.apps.map((a: { name: string }) => a.name)).toEqual(["erp", "crm"]);
    expect(read?.entry.cluster).toBe("s1");

    // record-inventory added a tenant_apps row for the new app + bumped the tenant's lastRunId
    const appRows = db.db.select().from(tenantApps).where(eq(tenantApps.tenantId, "tnt_1")).all();
    expect(appRows.map((a) => a.name).sort()).toEqual(["crm", "erp"]);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.lastRunId).toBe("run_add");

    expect(logs.some((l) => l.includes("appended to tenant"))).toBe(true);
    expect(logs.some((l) => l.includes("Synced + Healthy"))).toBe(true);
  });

  it("threads both seed tiers into the appended apps[] entry", async () => {
    seedClusters();
    const prt = ports();
    await runAll(params({ seedReference: true, seedDemo: true }), prt, []);
    const read = await prt.registrations.readTenant("prod", GUID);
    // The pre-seeded "erp" keeps its default-false tiers; the appended "crm" carries both tiers true.
    expect(read?.entry.apps).toEqual([
      { name: "erp", seedReference: false, seedDemo: false, selections: {} },
      { name: "crm", seedReference: true, seedDemo: true, selections: {} },
    ]);
  });

  it("apply-appproject creates the NEW member's own AppProject and touches no sibling's (no delete cleanup registered)", async () => {
    seedClusters();
    const projects = new FakeMasterProjectWriter();
    const cleanups: string[] = [];
    const p = params();
    const step = makeAddAppDef(ports({ projects })).steps(p).find((s) => s.name === "apply-appproject")!;
    const c = ctx(p, "apply-appproject", []);
    await step.run({ ...c, registerCleanup: (cl) => cleanups.push(cl.name) });
    const projectName = memberAppProject(GUID, NEW_APP, "prod");
    expect(projects.get("argocd", projectName)?.metadata.name).toBe(projectName);
    // the existing "erp" member's project is untouched — a member is self-contained, so adding an app
    // adds exactly one namespace and one AppProject, never a sibling's.
    expect(projects.get("argocd", memberAppProject(GUID, "erp", "prod"))).toBeUndefined();
    expect(cleanups).toEqual([]); // never registers a project delete — the member's namespace/AppProject are cluster state that stays
  });

  // The ensure-images gate's run-level tests (placement, probe behavior) live in
  // tenant-ensure-images.run.test.ts, and the argo-sync grant's in tenant-argo-sync.run.test.ts —
  // both shared with create-tenant (the onboard-activate pattern).

  it("append-app is idempotent on a resume (a second run does not double-append or throw)", async () => {
    seedClusters();
    const prt = ports();
    const p = params();
    const step = makeAddAppDef(prt).steps(p).find((s) => s.name === "append-app")!;
    await step.run(ctx(p, "append-app", []));
    await step.run(ctx(p, "append-app", []));
    const read = await prt.registrations.readTenant("prod", GUID);
    expect(read?.entry.apps.map((a: { name: string }) => a.name)).toEqual(["erp", "crm"]);
  });

  it("watch-sync-set waits ONLY on the new app's Application(s)", async () => {
    const prt = ports();
    const p = params();
    const step = makeAddAppDef(prt).steps(p).find((s) => s.name === "watch-sync-set")!;
    // scripted statuses cover exactly the new app's Application, so the watch converges
    await expect(step.run(ctx(p, "watch-sync-set", []))).resolves.toBeUndefined();

    const stalled = makeAddAppDef(ports({ argo: new FakeMasterArgoReader({}) })).steps(p).find((s) => s.name === "watch-sync-set")!;
    await expect(stalled.run(ctx(p, "watch-sync-set", []))).rejects.toThrow(/did not fully reach Synced/);
  });

  it("smoke checks the NEW member's own namespace (<guid>-<app>), never a sibling's", async () => {
    const memberNs = memberAppProject(GUID, NEW_APP, "prod"); // identity law: AppProject name == namespace
    const cluster = new FakeClusterReader({ smoke: { namespaceExists: false, workloads: [], externalSecretsReady: true } });
    const step = makeAddAppDef(ports({ cluster })).steps(params()).find((s) => s.name === "smoke")!;
    await expect(step.run(ctx(params(), "smoke", []))).rejects.toThrow(new RegExp(`namespace ${memberNs} does not exist`));
  });
});

describe("add-app streaming planner", () => {
  it("loads the live tenant, validates the new app, and freezes a plan (targetKind tenant)", async () => {
    seedClusters();
    const def = makeAddAppDef(ports());
    const result = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.guid).toBe(GUID);
    expect(result.params.app).toBe(NEW_APP);
    expect(result.params.chartsRef).toBe(SHA);
    // The registration is the GitOps truth for the tenant's target slave.
    expect(result.params.cluster).toBe("s1");
    expect(result.params.registryHost).toBe(REGISTRY_HOST); // registryHostFromChain over what ports.resolveClusterValueFiles answered for the tenant's cluster
    expect(result.params.expectedApps).toEqual([memberApplication(GUID, NEW_APP, "prod")]);
    expect(result.plan.targetKind).toBe("tenant");
    expect(result.plan.targetId).toBe("tnt_1");
    expect(result.plan.locks).toContainEqual({ resource: "git-branch", key: `catalog@${FAKE_BOOKS_BRANCH}` }); // the books branch, not the trunk the charts stand on
    expect(result.plan.steps.map((s) => s.name)).toEqual(def.steps(result.params).map((s) => s.name));
  });

  it("refuses a duplicate app", async () => {
    seedClusters();
    const def = makeAddAppDef(ports());
    await expect(def.planStream!({ tenantId: "tnt_1", app: "erp" }, planCtx())).rejects.toThrow(/already exists/);
  });

  // A standing bundle carries every app of its tenant: adding one the bundle lacks extends it —
  // the tenant-apps-repo steps ahead of the image gate, the render at the standing tag until
  // refresh-images re-renders at the built one (#215).
  it("renders the new app with the tenant's OWN bundle at its standing tag, and the steps extend the bundle with the app before the image gate", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } });
    const result = await makeAddAppDef(ports({ helm })).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(helm.requests.find((r) => r.namespace === `${GUID}-${NEW_APP}-prod`)?.valuesObject).toMatchObject({ tenant: { appsImage: TEST_BUNDLE.appsImage, appsImageTag: TEST_BUNDLE.appsImageTag } });
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params).toMatchObject({ appsImage: TEST_BUNDLE.appsImage, appsUnit: { org: ORG } });
    expect(result.plan.steps.map((s) => s.name).slice(0, 7)).toEqual(["attest-target", "create-repository", "write-tree", "onboard-build-only", "record-apps-repo", "refresh-images", "ensure-images"]);
    expect(result.plan.summary).toContain(`${ORG}/${TEST_BUNDLE.appsImage} gains "${NEW_APP}"`);
    // A registration naming another bundle is stale (its repository was renamed or removed): the
    // composer's name wins, the render mounts it at the placeholder, and the run creates it (#216).
    const stale = ports({ helm, registrations: new TenantRegistrations(seededPlatformRepo({ appsRepo: "https://github.com/acme-org/acme-apps.git", appsImage: "acme-apps", appsImageTag: TEST_BUNDLE.appsImageTag })) });
    const renamed = await makeAddAppDef(stale).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(renamed.outcome === "planned" && renamed.params.appsImage).toBe(TEST_BUNDLE.appsImage);
    expect(renamed.outcome === "planned" && renamed.plan.summary).toContain(`${ORG}/${TEST_BUNDLE.appsImage} is created from`);
  });

  // A tenant onboarded as its platform alone (#211) has no bundle: its first app is judged against
  // the TEMPLATE's catalog, the plan freezes the apps unit and the bundle at the placeholder tag, and
  // the run creates the bundle before the member is fanned out (#213).
  it("a tenant without a bundle: the plan freezes the apps unit and the steps create the bundle first, rendered at the placeholder", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } });
    const prt = ports({ helm, registrations: new TenantRegistrations(seededPlatformRepo({ appsImage: "", appsImageTag: "" })) });
    const result = await makeAddAppDef(prt).planStream!({ tenantId: "tnt_1", app: "web" }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params).toMatchObject({ app: "web", appsImage: "example-apps-acme", appsUnit: { org: ORG }, subdomain: "acme" });
    expect(helm.requests.find((r) => r.namespace === `${GUID}-web-prod`)?.valuesObject).toMatchObject({ tenant: { appsImage: "example-apps-acme" } });
    const names = result.plan.steps.map((s) => s.name);
    expect(names.slice(0, 7)).toEqual(["attest-target", "create-repository", "write-tree", "onboard-build-only", "record-apps-repo", "refresh-images", "ensure-images"]);
    expect(names.indexOf("apply-appproject")).toBeGreaterThan(names.indexOf("ensure-images"));
    expect(result.plan.summary).toContain(`${ORG}/example-apps-acme is created from`);
    // Without the App nothing can create the repository, and the plan says so.
    const { githubApp: _none, ...noApp } = prt;
    await expect(makeAddAppDef(noApp).planStream!({ tenantId: "tnt_1", app: "web" }, planCtx())).rejects.toThrow(/no GitHub App identity/);
  });

  // An app added after the platform pulls images no earlier run had to build (#214): the plan
  // resolves a build unit per missing image's repository exactly as create-tenant does, with its
  // owner's identity (#220), and places the build ahead of the image gate.
  it("a missing image the tenant spec's buildRepos names becomes a build unit ahead of ensure-images, nothing asked at approve", async () => {
    seedClusters();
    const PLATFORM_REPO = "https://github.com/acme/example-platform.git";
    const repo = new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML.replace("  members:", `  buildRepos:
    - repo: ${PLATFORM_REPO}
      builds: [example-engine]
  members:`), ...APP_OVERLAYS } });
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [NS_DOC, doc("Deployment", { raw: { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "engine", image: `${REGISTRY_HOST}/example-engine:0.4.0` }] } } } } })] } });
    const def = makeAddAppDef(ports({ repo, helm, registryProbe: new FakeRegistryProbe({ missing: ["example-engine:0.4.0"] }) }));
    const result = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.buildUnits).toEqual([{ unit: "example-platform", repoURL: PLATFORM_REPO, images: ["example-engine"], registered: false }]);
    expect(result.plan.requiredSecrets).toEqual([]);
    expect(result.plan.optionalSecrets).toBeUndefined();
    const names = result.plan.steps.map((s) => s.name);
    expect(names.indexOf(buildUnitStepName("example-platform"))).toBe(1); // right after attest-target
    expect(names.indexOf(buildUnitStepName("example-platform"))).toBeLessThan(names.indexOf("ensure-images"));
    expect(def.assertApprovable).toBeUndefined();
    // A missing image no buildRepos entry names is refused by name, never probed for again at run time.
    const nobody = makeAddAppDef(ports({ helm, registryProbe: new FakeRegistryProbe({ missing: ["example-engine:0.4.0"] }) }));
    const refused = await nobody.planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(refused.outcome).toBe("rejected");
    if (refused.outcome === "rejected") expect(refused.summary).toMatch(/buildRepos names no repository.*example-engine:0\.4\.0/);
  });

  it("freezes both requested seed tiers into params (default false when the request omits them)", async () => {
    seedClusters();
    const def = makeAddAppDef(ports());
    const seeded = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP, seedReference: true, seedDemo: true }, planCtx());
    expect(seeded.outcome === "planned" && seeded.params.seedReference).toBe(true);
    expect(seeded.outcome === "planned" && seeded.params.seedDemo).toBe(true);
    const plain = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(plain.outcome === "planned" && plain.params.seedReference).toBe(false);
    expect(plain.outcome === "planned" && plain.params.seedDemo).toBe(false);
  });

  it("freezes every further selection into params, and T4 refuses one the TENANT's entry does not declare", async () => {
    seedClusters();
    const def = makeAddAppDef(ports());
    // The template's apps.yaml declares the two seed selections for the new app and nothing else —
    // so a further selection is exactly what T4 refuses here.
    const refused = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP, selections: { seedPrices: true } }, planCtx());
    expect(refused.outcome).toBe("rejected");
    expect(refused.outcome === "rejected" && refused.summary).toMatch(/T4/);
    const planned = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP, seedReference: true, selections: {} }, planCtx());
    expect(planned.outcome === "planned" && planned.params.selections).toEqual({});
    // The same selection passes once the template's entry declares it — the template's catalog is
    // the judge, for a standing tenant as for a new one.
    const priced = ports({}, TEMPLATE_APPS(`      seedPrices: { title: "Prices", default: false }\n`));
    const accepted = await makeAddAppDef(priced).planStream!({ tenantId: "tnt_1", app: NEW_APP, selections: { seedPrices: true } }, planCtx());
    expect(accepted.outcome === "planned" && accepted.params.selections).toEqual({ seedPrices: true });
  });

  it("refuses by name an app the template's catalog lacks, and a Manager without the App", async () => {
    seedClusters();
    await expect(makeAddAppDef(ports()).planStream!({ tenantId: "tnt_1", app: "shop" }, planCtx())).rejects.toThrow(/shop is not in the template's apps\.yaml/);
    const { githubApp: _none, ...withoutApp } = ports();
    await expect(makeAddAppDef(withoutApp).planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx())).rejects.toThrow(/no GitHub App identity/);
  });

  it("freezes the full report as a rejection when the new app escapes the namespace fence (T3)", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [doc("ClusterRole")] } });
    const def = makeAddAppDef(ports({ helm }));
    const result = await def.planStream!({ tenantId: "tnt_1", app: NEW_APP }, planCtx());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toMatch(/T3/);
    expect((result.planJson as TenantValidationReport).verdict).toBe("fail");
  });
});
