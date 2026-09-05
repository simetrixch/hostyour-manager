import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { makeAddAppDef, AddAppParams } from "./add-app.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { memberApplication, tenantApplicationSet } from "./tenant-fanout.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { TenantValidationReport } from "../../../shared/tenant.ts";
import { STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";


// The ensure-images gate at RUN level — its placement inside the create-tenant/add-app step lists,
// the probe behavior through the frozen requiredImages params, and the planStream freezing. The
// step's own unit checks live in ensure-images.test.ts; this file follows the
// onboard-activate.run.test.ts pattern (a dedicated file per step concern) so the two big run
// suites stay within the file-size doctrine.

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const HOST = "zot.m1.example"; // what the ports fixture resolves for the target cluster — the filter pivot
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
const APPS = [{ name: "erp" }];
const ENGINE = { repo: "example-engine", tag: "0.4.0" };

/** A cluster-marking resolver that answers every cluster short name at "prod" — every fixture in this
 *  file lands its tenant on s1/prod, so a single-stage stand-in is all TenantRegistrations needs to
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

const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}`, raw: { kind }, ...over,
});
// No Tenant CR document: the Manager provisions that object itself (provision-tenant-cr), and the
// T3 isolation gate now refuses a chart that renders one (CLUSTER_SCOPED_FORBIDDEN includes "Tenant").
const CLEAN_DOCS = [
  doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }),
  doc("Deployment"),
];

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function passReport(): TenantValidationReport {
  return composeTenantReport({
    resolvedSha: SHA, probeGuid: GUID, appsValidated: ["erp"], resolvedMembers: ["base", "auth", "erp-engine", "erp-front"],
    startedAt: 1, finishedAt: 2, manifest: null,
    gates: [{ id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" }],
  });
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

function ports(over: Partial<TenantOnboardPorts> = {}): TenantOnboardPorts {
  return {
    // The Vault seeder the seed-tenant-crypto step writes through. Records nothing: what it wrote is
    // irrecoverable by design (the Manager holds no read grant), so a test can only assert THAT the
    // entry was created, which the step log carries.
    seeder: fakeTenantSeeder(),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations: new TenantRegistrations(new FakePlatformRepo(), CLUSTER_STAGE),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({}),
      argoReader: new FakeMasterArgoReader({}),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  endpoints:\n    registry:\n      host: ${HOST}\n` }],
    registryProbe: new FakeRegistryProbe(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }],
    consumerNames: async () => [],
    ...over,
  };
}

function createParams(over: Partial<CreateTenantParams> = {}): CreateTenantParams {
  return CreateTenantParams.parse({
    guid: GUID, subdomain: "acme.example", stage: "prod", clusterId: "cls_1", domain: "s1.example",
    members: testMembers(APPS),
    identityProvider: "auth",
    cluster: "s1", chartsRef: SHA, registryHost: HOST,
    apps: APPS, seedUsers: false, quota: seedQuota("small"), owner: "team-acme",
    report: passReport(), expectedApps: tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], GUID, "prod"), catalogRepoUrl: DEPLOY_URL,
    ...over,
  });
}

function addParams(over: Partial<AddAppParams> = {}): AddAppParams {
  return AddAppParams.parse({
    tenantId: "tnt_1", guid: GUID, stage: "prod", clusterId: "cls_1", domain: "s1.example",
    cluster: "s1", registryHost: HOST, chartsRef: SHA, app: "crm", member: testMembers(["crm"])[3]!,
    report: passReport(), expectedApps: [memberApplication(GUID, "crm", "prod")], catalogRepoUrl: DEPLOY_URL,
    ...over,
  });
}

function ctx(p: Record<string, unknown>, logs: string[]): StepCtx {
  return {
    runId: "run_img", stepName: "ensure-images", db: db.db, creds: {} as unknown as CredentialStore, params: p,
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

function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

describe("ensure-images placement (both tenant runs)", () => {
  it("create-tenant: strictly after record-provisional and before apply-appprojects (before write-registration)", () => {
    const names = makeCreateTenantDef(ports()).steps(createParams()).map((s) => s.name);
    // seed-tenant-crypto sits between them: the crypto entry is written before anything the fan-out
    // reads it from exists, and the image probe still precedes every mutation that deploys.
    expect(names.indexOf("ensure-images")).toBeGreaterThan(names.indexOf("record-provisional"));
    expect(names.indexOf("seed-tenant-crypto")).toBeLessThan(names.indexOf("write-registration"));
    expect(names.indexOf("ensure-images")).toBeLessThan(names.indexOf("apply-appprojects"));
    expect(names.indexOf("ensure-images")).toBeLessThan(names.indexOf("write-registration"));
  });

  it("add-app: strictly between attest-target and apply-appproject (before append-app)", () => {
    const names = makeAddAppDef(ports()).steps(addParams()).map((s) => s.name);
    expect(names.indexOf("ensure-images")).toBe(names.indexOf("attest-target") + 1);
    expect(names.indexOf("ensure-images")).toBeLessThan(names.indexOf("apply-appproject"));
    expect(names.indexOf("ensure-images")).toBeLessThan(names.indexOf("append-app"));
  });
});

describe("ensure-images through the frozen run params", () => {
  const stepOf = (prt: TenantOnboardPorts, p: CreateTenantParams) =>
    makeCreateTenantDef(prt).steps(p).find((s) => s.name === "ensure-images")!;

  it("probes every requiredImages entry against the tenant's registry host and passes when all are present", async () => {
    const registryProbe = new FakeRegistryProbe(); // defaults: everything present
    const p = createParams({ requiredImages: [ENGINE] });
    await stepOf(ports({ registryProbe }), p).run(ctx(p, []));
    expect(registryProbe.probes).toEqual(["example-engine:0.4.0"]);
  });

  it("a MISSING image fails create-tenant before any mutation, naming the tag", async () => {
    const registryProbe = new FakeRegistryProbe({ missing: ["example-engine:0.4.0"] });
    const p = createParams({ requiredImages: [ENGINE] });
    await expect(stepOf(ports({ registryProbe }), p).run(ctx(p, []))).rejects.toThrow(/missing image\(s\).*example-engine:0\.4\.0/);
  });

  it("names EVERY missing image in one failure, not just the first", async () => {
    const registryProbe = new FakeRegistryProbe({ missing: ["example-engine:0.4.0", "example-auth:0.5.0"] });
    const p = createParams({ requiredImages: [ENGINE, { repo: "example-auth", tag: "0.5.0" }] });
    await expect(stepOf(ports({ registryProbe }), p).run(ctx(p, []))).rejects.toThrow(/example-engine:0\.4\.0, example-auth:0\.5\.0/);
  });

  it("add-app runs the SAME step off its own frozen requiredImages", async () => {
    const registryProbe = new FakeRegistryProbe({ missing: ["example-engine:0.4.0"] });
    const p = addParams({ requiredImages: [ENGINE] });
    const step = makeAddAppDef(ports({ registryProbe })).steps(p).find((s) => s.name === "ensure-images")!;
    await expect(step.run(ctx(p, []))).rejects.toThrow(/missing image\(s\).*example-engine:0\.4\.0/);
  });
});

describe("create-tenant planStream resolves the registry host", () => {
  it("freezes the registrations of a cluster whose build plane is NOT its master — never zot.<master>", async () => {
    seedClusters();
    const resolved: string[] = [];
    const prt = ports({
      resolveClusterValueFiles: async (domain, stage) => {
        resolved.push(`${domain}/${stage}`);
        // the profile's zot.<build-plane> for a foreign build plane
        return [{ path: clusterMapPath("m1.example"), content: "global:\n  endpoints:\n    registry:\n      host: zot.build1.example\n" }];
      },
    });
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", subdomain: "acme.example", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.registryHost).toBe("zot.build1.example");
    expect(resolved).toEqual(["s1.example/prod"]); // asked for the TARGET cluster's chain, not the master's
  });

  it("rejects loud when the target cluster's chain resolves no registry host", async () => {
    seedClusters();
    // A chain that states no registry host — registryHostFromChain itself must reject the plan loud.
    const prt = ports({ resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: "global: {}\n" }] });
    await expect(makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", subdomain: "a.example", owner: "o", apps: [] }, planCtx())).rejects.toThrow(/registry\.host/);
  });
});

describe("create-tenant planStream freezes requiredImages", () => {
  it("extracts the validated render's images, filtered to the frozen registryHost, into params", async () => {
    seedClusters();
    const docsWithImages = [
      ...CLEAN_DOCS,
      doc("Deployment", {
        raw: { kind: "Deployment", spec: { template: { spec: {
          containers: [
            { name: "engine", image: `${HOST}/example-engine:0.4.0` },
            { name: "cache", image: "docker.io/library/redis:7" }, // a foreign registrations is never ours to check
          ],
          initContainers: [{ name: "auth-wait", image: `${HOST}/example-auth:0.5.0` }],
        } } } },
      }),
    ];
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: docsWithImages } });
    const def = makeCreateTenantDef(ports({ helm }));
    const result = await def.planStream!({ clusterId: "cls_1", subdomain: "acme.example", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.requiredImages).toEqual([
      { repo: "example-auth", tag: "0.5.0" },
      { repo: "example-engine", tag: "0.4.0" },
    ]);
  });
});
