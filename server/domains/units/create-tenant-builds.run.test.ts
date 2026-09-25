// The tenant onboarding builds the images its fan-out lacks (hostyour-manager#165): the plan maps
// every missing image to the repository the catalogue's tenant.buildRepos names and asks one PAT per
// repository the installation has not registered; the run onboards each such unit build-only before
// the tenant's own writes and re-reads the image set off the pins the builds wrote.
import { dropCredentialRows } from "../../security/store.fixture.ts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { resolveBuildUnits, buildUnitStep, buildUnitStepName, refreshImagesStep, channelReaching, type TenantBuildRuntime } from "./tenant-builds.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { tenantApplicationSet } from "./tenant-fanout.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { ports as onboardPorts } from "./onboard.fixture.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { TenantValidationReport } from "../../../shared/tenant.ts";
import type { VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import { STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers, APP_OVERLAYS } from "./tenant-members.fixture.ts";
import { TEMPLATE_SPEC, withAppsTemplate, recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const HOST = "zot.m1.example";
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
const JOBS_REPO = "https://github.com/acme/example-jobs.git";
const PLATFORM_REPO = "https://github.com/acme/example-platform.git";
const APPS = [{ name: "erp" }];
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
${TEMPLATE_SPEC}  buildRepos:
    - repo: ${JOBS_REPO}
      builds: [example-jobs]
    - repo: ${PLATFORM_REPO}
      builds: [example-engine]
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;
/** The build unit's own manifest, as the ungated read parses it off its repository: build-only. */
const JOBS_MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: example-jobs
owner: platform
envs: [dev, test, prod]
builds:
  - name: example-jobs
    containerfile: Containerfile
`;
const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}`, raw: { kind }, ...over,
});
const withImages = (tags: { jobs: string; engine: string }): RenderedDoc[] => [
  doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }),
  doc("Deployment", {
    raw: { kind: "Deployment", spec: { template: { spec: { containers: [
      { name: "jobs", image: `${HOST}/example-jobs:${tags.jobs}` },
      { name: "engine", image: `${HOST}/example-engine:${tags.engine}` },
    ] } } } },
  }),
];
const TRUNK_DOCS = withImages({ jobs: "0.2.0", engine: "0.4.0" });
const BUILT_DOCS = withImages({ jobs: "0.1.0-stable-20260101000000-abc1234", engine: "0.4.0" });

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); });
afterEach(() => { db.sqlite.close(); });

function passReport(): TenantValidationReport {
  return composeTenantReport({
    resolvedSha: SHA, probeGuid: GUID, appsValidated: ["erp"], resolvedMembers: ["auth", "jobs", "report", "erp"],
    startedAt: 1, finishedAt: 2, manifest: null,
    gates: [{ id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" }],
  });
}
function fakeTenantSeeder(): VaultSeeder {
  return {
    seed: () => Promise.reject(new Error("a tenant run never seeds a consumer entry")),
    patchApp: async () => undefined,
    seedPostgres: () => Promise.reject(new Error("no")), seedMongodb: () => Promise.reject(new Error("no")),
    seedBuildRepoPat: () => Promise.reject(new Error("a tenant run never seeds a repo pat itself")),
    refreshBuildRepoPat: () => Promise.reject(new Error("a tenant run never refreshes a repo pat itself")),
    deleteBuildRepoPat: async () => {}, deleteApp: async () => {}, deletePostgres: async () => {}, deleteMongodb: async () => {},
    seedTenantCrypto: async () => ({ created: true }), deleteTenantCrypto: async () => {},
  };
}
function ports(over: Partial<TenantOnboardPorts> = {}): TenantOnboardPorts {
  return {
    seeder: fakeTenantSeeder(),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML, ...APP_OVERLAYS } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: TRUNK_DOCS } }),
    registrations: new TenantRegistrations(new FakePlatformRepo()),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({}), argoReader: new FakeMasterArgoReader({}), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: ${HOST}\n` }],
    registryProbe: new FakeRegistryProbe(),
    dns: new FakeDnsProvider(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }],
    consumerHostLabels: async () => [],
    ...over,
  };
}
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
/** A credential store standing on the App's ONE row (#226) — `cred_app`, the owner acme's — and
 *  every open recorded, so a test reads which credential a unit was reached with. */
function ctx(p: Record<string, unknown>, logs: string[], opened: string[] = []): StepCtx {
  const creds = {
    seal: async () => { throw new Error("no row is sealed per unit (#226)"); },
    open: async (id: string) => { opened.push(id); return Buffer.from("ghp_test"); },
    list: async ({ kind }: { kind?: string } = {}) => [{ id: "cred_app", kind: "github-app", label: "GitHub App (acme)", fingerprint: "sha256:app", subject: { kind: "owner", id: "acme" }, purpose: "repository-identity" }].filter((r) => !kind || r.kind === kind),
  };
  return {
    runId: "run_bld", stepName: "build", db: db.db, creds: creds as unknown as CredentialStore, params: p,
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
const BUILD_REPOS = [{ repo: JOBS_REPO, builds: ["example-jobs"] }, { repo: PLATFORM_REPO, builds: ["example-engine"] }];

describe("resolveBuildUnits — the missing images grouped by the repository that builds them", () => {
  it("one unit per repository, named by the repository, registered or not; an image nobody builds is unmapped", async () => {
    const r = await resolveBuildUnits({
      missing: [{ repo: "example-jobs", tag: "0.2.0" }, { repo: "example-engine", tag: "0.4.0" }, { repo: "example-nobody", tag: "1" }],
      buildRepos: BUILD_REPOS,
      registration: async (unit) => (unit === "example-platform" ? { form: "build-only" } : null),
    });
    expect(r.units).toEqual([
      { unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: false },
      { unit: "example-platform", repoURL: PLATFORM_REPO, images: ["example-engine"], registered: true, form: "build-only" },
    ]);
    expect(r.unmapped).toEqual([{ repo: "example-nobody", tag: "1" }]);
  });
});

describe("channelReaching — the highest channel whose ceiling admits the stage", () => {
  const table = { alpha: ["dev" as const], beta: ["dev" as const, "test" as const], stable: ["dev" as const, "test" as const, "prod" as const] };
  it("stable for prod, stable for dev too (a tenant is never a pre-release), refused where nothing reaches", () => {
    expect(channelReaching(table, "prod")).toBe("stable");
    expect(channelReaching(table, "dev")).toBe("stable");
    expect(() => channelReaching({ alpha: ["dev"] }, "prod")).toThrow(/no release channel reaches stage prod/);
  });
});

describe("create-tenant planStream — the build units and their owner's identity (#220)", () => {
  it("lists a build unit per missing image's repository, asks nothing at approve, and places its steps before the tenant's writes", async () => {
    seedClusters();
    const prt = withAppsTemplate(ports({ registryProbe: new FakeRegistryProbe({ missing: ["example-jobs:0.2.0"] }) }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.buildUnits).toEqual([{ unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: false }]);
    expect(result.plan.requiredSecrets).toEqual([]);
    expect(result.plan.optionalSecrets).toBeUndefined();
    expect(result.plan.warnings[0]).toContain("example-jobs: example-jobs");
    const names = result.plan.steps.map((s) => s.name);
    expect(names.indexOf(buildUnitStepName("example-jobs"))).toBeGreaterThan(names.indexOf("record-provisional"));
    expect(names.indexOf(buildUnitStepName("example-jobs"))).toBeLessThan(names.indexOf("seed-tenant-crypto"));
    expect(names.indexOf("refresh-images")).toBe(names.indexOf("ensure-images") - 1);
  });
  it("refuses, naming the owner and the page, a build unit whose owner records no identity", async () => {
    seedClusters();
    dropCredentialRows(db.db, { kind: "owner", id: "acme" });
    const prt = withAppsTemplate(ports({ registryProbe: new FakeRegistryProbe({ missing: ["example-jobs:0.2.0"] }) }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toMatch(/build unit example-jobs .* has no identity: .*owner acme records no repository PAT .* consumer wizard/);
  });
  it("a registered build-only unit is re-released with its stored credential and asks for nothing", async () => {
    seedClusters();
    const prt = withAppsTemplate(ports({
      registryProbe: new FakeRegistryProbe({ missing: ["example-engine:0.4.0"] }),
      buildUnitRegistration: async (unit) => (unit === "example-platform" ? { form: "build-only" } : null),
    }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.buildUnits[0]).toMatchObject({ unit: "example-platform", registered: true });
    expect(result.plan.requiredSecrets).toEqual([]);
  });
  it("refuses a render that pulls the apps TEMPLATE (tenant.appsBundle), by name, before the registry is asked — a stale chart is named, never built", async () => {
    seedClusters();
    // The catalog names example-apps as the template; the fixture's engine chart still mounts it.
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [...TRUNK_DOCS, doc("Deployment", { name: "x", raw: { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "n", image: `${HOST}/example-apps:0.9.0` }] } } } } })] } });
    const probe = new FakeRegistryProbe({ missing: [] }); // the registry still carries the template's image
    const prt = withAppsTemplate(ports({ helm, registryProbe: probe }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toMatch(/example-apps:0\.9\.0.*"example-apps" is the catalogue's apps template \(tenant\.appsBundle\).*never built and never mounted/);
    expect(probe.probes).toEqual([]);
  });
  it("no image missing ⇒ no build unit and no secret; the refresh step stays, because the tenant's own bundle is built by the run", async () => {
    seedClusters();
    const result = await makeCreateTenantDef(withAppsTemplate(ports())).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.buildUnits).toEqual([]);
    expect(result.plan.requiredSecrets).toEqual([]);
    expect(result.plan.steps.map((s) => s.name)).toContain("refresh-images");
  });
  it("refuses a missing image no buildRepos entry names, by name", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [...TRUNK_DOCS, doc("Deployment", { name: "x", raw: { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "n", image: `${HOST}/example-nobody:1` }] } } } } })] } });
    const prt = withAppsTemplate(ports({ helm, registryProbe: new FakeRegistryProbe({ missing: ["example-nobody:1"] }) }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toMatch(/tenant\.buildRepos names no repository.*example-nobody:1/);
  });
  it("refuses a missing image of a unit registered as deployable — its release is the unit's own act", async () => {
    seedClusters();
    const prt = withAppsTemplate(ports({
      registryProbe: new FakeRegistryProbe({ missing: ["example-jobs:0.2.0"] }),
      buildUnitRegistration: async (unit) => (unit === "example-jobs" ? { form: "deployable" } : null),
    }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toMatch(/registered as deployable \(example-jobs\)/);
  });
});

describe("buildUnitStep — the consumer's build-only chain, run for one unit inside the tenant run", () => {
  it("reaches the unit with the owner's repository PAT row, resolves version and channel, registers the unit and watches its release", async () => {
    seedClusters();
    const buildPlane = new FakeBuildPlane();
    buildPlane.seedReleaseRun("example-jobs", { runName: "example-jobs-release-1", releaseTag: "0.1.0-stable-20260101000000", succeeded: true });
    const onboard = onboardPorts({
      repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/platform.yaml": JOBS_MANIFEST_YAML } }),
      buildPlane,
    });
    const unit = { unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: false };
    const step = buildUnitStep(() => ({ ports: onboard }), { guid: GUID, owner: "team-acme", stage: "prod" }, unit);
    const logs: string[] = [];
    const opened: string[] = [];
    await step.run(ctx(params(), logs, opened));
    expect(opened).toContain("cred_pat_acme"); // acme's repository PAT row (recordTestOwners); the App does not reach it — no row of the unit's (#226)
    // The unit stands registered build-only on the books branch, its release watched at the version
    // read off the repository's tags (none ⇒ 0.1.0) on the channel that reaches prod.
    expect(await onboard.registrations.readBuildRegistration("example-jobs")).not.toBeNull();
    expect(buildPlane.releaseWatches).toEqual([{ unit: "example-jobs", version: "0.1.0", channel: "stable" }]);
    expect(logs.some((l) => l.includes("build unit example-jobs done"))).toBe(true);
  });
  describe("a registered unit whose manifest declares other builds than it attests", () => {
    const rendering = (builds: string[]): FakeMasterArgoReader => new FakeMasterArgoReader({ statuses: new Map([["example-jobs-build", {
      syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy",
      syncSources: [{ repoURL: "https://github.com/x/hostyour-cloud.git", revision: SHA }, { repoURL: "https://github.com/x/hostyour-cloud.git", revision: SHA, path: "clusters/inventories/consumer-build", valuesObject: { unit: { name: "example-jobs", buildsJson: JSON.stringify(builds) } } }],
    } as ArgoAppStatus]]) });
    async function standing(extra: { buildArgo: FakeMasterArgoReader }, manifest = JOBS_MANIFEST_YAML, registration: { repoURL?: string; owner?: string; suspended?: boolean; quiesced?: boolean } = {}) {
      seedClusters();
      const buildPlane = new FakeBuildPlane();
      buildPlane.seedReleaseRun("example-jobs", { runName: "example-jobs-release-2", releaseTag: "0.1.0-stable-20260101000000", succeeded: true });
      const onboard = onboardPorts({ repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/platform.yaml": manifest } }), buildPlane, ...extra });
      await onboard.registrations.commitRegistration({
        unit: { name: "example-jobs", repoURL: registration.repoURL ?? JOBS_REPO, owner: registration.owner ?? "team-acme", onboardedAt: "2026-01-01T00:00:00.000Z", suspended: registration.suspended ?? false, quiesced: registration.quiesced ?? false },
        builds: ["example-jobs-old"], runId: "run_old",
      });
      const unit = { unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: true, form: "build-only" as const };
      return { onboard, buildPlane, step: buildUnitStep(() => ({ ports: onboard }), { guid: GUID, owner: "team-acme", stage: "prod" }, unit) };
    }
    it("attests them again, keeps the rest of the registration, and releases once the build Application renders them", async () => {
      const { onboard, buildPlane, step } = await standing({ buildArgo: rendering(["example-jobs"]) });
      const logs: string[] = [];
      await step.run(ctx(params(), logs, []));
      const entry = (await onboard.registrations.readBuildRegistration("example-jobs"))?.entry;
      expect(entry?.builds).toEqual(["example-jobs"]);
      expect(entry?.onboardedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(buildPlane.releaseWatches).toHaveLength(1);
      expect(logs.some((l) => l.includes("builds attested again"))).toBe(true);
    });
    it("does not trigger the release while the build Application still renders the old builds", async () => {
      const { buildPlane, step } = await standing({ buildArgo: rendering(["example-jobs-old"]) });
      await expect(step.run(ctx(params(), [], []))).rejects.toThrow(/does not render the builds example-jobs yet.*rendering example-jobs-old/);
      expect(buildPlane.releaseWatches).toEqual([]);
    });
    it("waits on a retry too: builds already attested, the build Application still rendering the old ones", async () => {
      const { onboard, buildPlane, step } = await standing({ buildArgo: rendering(["example-jobs-old"]) });
      await onboard.registrations.commitRegistration({
        unit: { name: "example-jobs", repoURL: JOBS_REPO, owner: "team-acme", onboardedAt: "2026-01-01T00:00:00.000Z", suspended: false, quiesced: false },
        builds: ["example-jobs"], runId: "run_first_attempt",
      });
      await expect(step.run(ctx(params(), [], []))).rejects.toThrow(/does not render the builds example-jobs yet/);
      expect(buildPlane.releaseWatches).toEqual([]);
    });
    it("waits for the sync as well: the new builds compared but the Application still OutOfSync", async () => {
      const argo = rendering(["example-jobs"]);
      const status = (argo as unknown as { scripted: { statuses: Map<string, ArgoAppStatus> } }).scripted.statuses.get("example-jobs-build")!;
      argo.setStatuses(new Map([["example-jobs-build", { ...status, sync: "OutOfSync" }]]));
      const { buildPlane, step } = await standing({ buildArgo: argo });
      await expect(step.run(ctx(params(), [], []))).rejects.toThrow(/OutOfSync/);
      expect(buildPlane.releaseWatches).toEqual([]);
    });
    it("keeps the unit's own names and every other field of the registration", async () => {
      const both = `${JOBS_MANIFEST_YAML}  - name: example-jobs-old
    containerfile: Containerfile
`;
      const { onboard, step } = await standing({ buildArgo: rendering(["example-jobs", "example-jobs-old"]) }, both,
        { repoURL: "https://github.com/standing-owner/example-jobs.git", owner: "team-standing", suspended: true, quiesced: true });
      await step.run(ctx(params(), [], []));
      const entry = (await onboard.registrations.readBuildRegistration("example-jobs"))?.entry;
      expect(entry?.builds).toEqual(["example-jobs", "example-jobs-old"]); // its own old name is no clash with itself
      expect(entry).toMatchObject({ repoURL: "https://github.com/standing-owner/example-jobs.git", owner: "team-standing", suspended: true, quiesced: true });
    });
    it("refuses a build name another unit attests, writing nothing", async () => {
      const { onboard, step } = await standing({ buildArgo: rendering(["example-jobs"]) });
      await onboard.registrations.commitRegistration({
        unit: { name: "other-unit", repoURL: "https://github.com/acme/other-unit.git", suspended: false, quiesced: false }, builds: ["example-jobs"], runId: "run_other",
      });
      await expect(step.run(ctx(params(), [], []))).rejects.toThrow(/example-jobs \(attested by other-unit\)/);
      expect((await onboard.registrations.readBuildRegistration("example-jobs"))?.entry.builds).toEqual(["example-jobs-old"]);
    });
  });

  // The rule of #220 on the tenant path: a unit the App reaches is reached with the App's one row, one
  // it does not with its owner's repository PAT row, and one whose owner records nothing refuses.
  it("reaches a unit the App reaches with the App's row, one it does not with the owner's repository PAT row, and refuses one of an unrecorded owner", async () => {
    seedClusters();
    const unit = { unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: false };
    const make = () => {
      const buildPlane = new FakeBuildPlane();
      buildPlane.seedReleaseRun("example-jobs", { runName: "example-jobs-release-1", releaseTag: "0.1.0-stable-20260101000000", succeeded: true });
      return onboardPorts({ repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/platform.yaml": JOBS_MANIFEST_YAML } }), buildPlane });
    };
    const reaching = new FakeGitHubApp();
    reaching.org = "acme"; // the App is installed in the owner of JOBS_REPO
    const viaApp: string[] = [];
    await buildUnitStep(() => ({ ports: make(), githubApp: reaching }), { guid: GUID, owner: "team-acme", stage: "prod" }, unit).run(ctx(params(), [], viaApp));
    expect(viaApp).toContain("cred_app");
    expect(viaApp).not.toContain("cred_pat_acme");
    const elsewhere = new FakeGitHubApp(); // installed in example-org: acme's repository PAT is the identity
    const viaPat: string[] = [];
    await buildUnitStep(() => ({ ports: make(), githubApp: elsewhere }), { guid: GUID, owner: "team-acme", stage: "prod" }, unit).run(ctx(params(), [], viaPat));
    expect(viaPat).toContain("cred_pat_acme");
    expect(viaPat).not.toContain("cred_app");
    const nobody = { unit: "x", repoURL: "https://github.com/nobody/x.git", images: ["x"], registered: false };
    await expect(buildUnitStep(() => ({ ports: make(), githubApp: elsewhere }), { guid: GUID, owner: "team-acme", stage: "prod" }, nobody).run(ctx(params(), [])))
      .rejects.toThrow(/owner nobody records no repository PAT/);
  });
  it("refuses when the consumer onboarding is not wired, naming it", async () => {
    seedClusters();
    const unit = { unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: false };
    const step = buildUnitStep(() => undefined, { guid: GUID, owner: "team-acme", stage: "prod" }, unit);
    await expect(step.run(ctx(params(), []))).rejects.toThrow(/consumer onboarding is not wired/);
  });
});

describe("refreshImagesStep — the image set re-read off the pins the builds wrote", () => {
  it("replaces the plan's frozen set with the re-rendered one and names every tag that moved", async () => {
    const runtime: TenantBuildRuntime = {};
    const prt = ports({ helm: new FakeHelmRenderer({ fallback: { ok: true, docs: BUILT_DOCS } }) });
    const p = params({ requiredImages: [{ repo: "example-jobs", tag: "0.2.0" }, { repo: "example-engine", tag: "0.4.0" }] });
    const logs: string[] = [];
    await refreshImagesStep(prt, { guid: GUID, domain: "s1.example", stage: "prod", subdomain: "acme", apps: APPS, seedUsers: false, registryHost: HOST, requiredImages: p.requiredImages }, runtime).run(ctx(p, logs));
    expect(runtime.requiredImages).toEqual([{ repo: "example-engine", tag: "0.4.0" }, { repo: "example-jobs", tag: "0.1.0-stable-20260101000000-abc1234" }]);
    expect(runtime.syncUnits).toEqual(["example-platform"]);
    expect(logs.some((l) => l.includes("example-jobs: 0.2.0 -> 0.1.0-stable-20260101000000-abc1234"))).toBe(true);
  });
});
