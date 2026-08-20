import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { makeAddAppDef, AddAppParams } from "./add-app.run.ts";
import { TenantRegistry } from "./tenant-registry.ts";
import type { ClusterStageResolver } from "./registry.ts";
import { memberApplication, tenantApplicationSet } from "./tenant-fanout.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { BUILD_PIPELINE_SERVICE_ACCOUNT } from "./build-rbac.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { RoleManifest, RoleBindingManifest } from "../../adapters/kube/port.ts";
import type { TenantValidationReport, TenantRegistration } from "../../../shared/tenant.ts";
import { STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";


// The tenant's argo-sync grant at RUN level: where create-tenant writes it, what add-app extends it
// to, and where its subjects come from. Nothing else in the product lets a release deploy into a
// tenant NOW instead of on ArgoCD's next poll, and nothing else keeps one tenant off another's
// Applications once it does. The render's own checks live in build-rbac.test.ts; this file follows
// the tenant-ensure-images.run.test.ts pattern (a dedicated file per step concern) so the two big run
// suites stay within the file-size doctrine.

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const HOST = "zot.m1.example"; // what the ports fixture resolves for the target cluster
const DEPLOY_URL = "https://github.com/simetrixch/catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
const APPS = [{ name: "erp" }];
const NEW_APP = "crm";
// Who builds what, as the registration branch states it: example-platform builds the engine image this
// tenant pulls; swissbookai is a unit standing beside it that builds none of them.
const ATTESTED = [
  { unit: "example-platform", build: "example-engine" },
  { unit: "swissbookai", build: "swissbookai-api" },
];

/** A cluster-marking resolver that answers every cluster short name at "prod" — every fixture in this
 *  file lands its tenant on s1/prod, so a single-stage stand-in is all TenantRegistry needs to
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
const CLEAN_DOCS = [doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }), doc("Deployment")];

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

function passReport(): TenantValidationReport {
  return composeTenantReport({
    resolvedSha: SHA, probeGuid: GUID, appsValidated: ["erp"], resolvedMembers: ["auth", "jobs", "report", "erp-engine", "erp-front"],
    startedAt: 1, finishedAt: 2, manifest: null,
    gates: [{ id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" }],
  });
}

/** A registry whose repo already carries the tenant's registration with its one app — what add-app
 *  reads the tenant's standing members off. */
async function seededRegistry(): Promise<TenantRegistry> {
  const registry = new TenantRegistry(new FakePlatformRepo(), CLUSTER_STAGE);
  const registration: TenantRegistration = {
    cluster: "s1", subdomain: "acme.example",
    members: testMembers(APPS), identityProvider: "auth", apps: APPS.map((a) => ({ name: a.name, seedReference: false, seedDemo: false })),
    seedUsers: false, quota: seedQuota("small"), resetNonce: "1", suspended: false, quiesced: false,
  };
  await registry.commitTenant({ stage: "prod", guid: GUID, registration, runId: "run_onb" });
  return registry;
}

function ports(over: Partial<TenantOnboardPorts> = {}): TenantOnboardPorts {
  return {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registry: new TenantRegistry(new FakePlatformRepo(), CLUSTER_STAGE),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({}),
      argoReader: new FakeMasterArgoReader({}),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "s1", // the per-slave ArgoCD namespace the tenant's Applications live in
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: "installation/profile.yaml", content: `global:\n  endpoints:\n    registry:\n      host: ${HOST}\n` }],
    registryProbe: new FakeRegistryProbe(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => ATTESTED,
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
    syncUnits: ["example-platform"],
    ...over,
  });
}

function addParams(over: Partial<AddAppParams> = {}): AddAppParams {
  return AddAppParams.parse({
    tenantId: "tnt_1", guid: GUID, stage: "prod", clusterId: "cls_1", domain: "s1.example",
    cluster: "s1", registryHost: HOST, chartsRef: SHA, app: NEW_APP, member: testMembers([NEW_APP])[3]!,
    report: passReport(), expectedApps: [memberApplication(GUID, NEW_APP, "prod")], catalogRepoUrl: DEPLOY_URL,
    syncUnits: ["example-platform"],
    ...over,
  });
}

function ctx(p: Record<string, unknown>, logs: string[]): StepCtx {
  return {
    runId: "run_sync", stepName: "provision-argo-sync", db: db.db, creds: {} as unknown as CredentialStore, params: p,
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
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active", tier: "rehearsal" }).run();
}

const roleOf = (w: FakeBuildRbacWriter, ns = "s1") => w.get("Role", ns, `${GUID}-argo-sync`) as RoleManifest | undefined;
const bindingOf = (w: FakeBuildRbacWriter, ns = "s1") => w.get("RoleBinding", ns, `${GUID}-argo-sync`) as RoleBindingManifest | undefined;

describe("create-tenant provisions the grant", () => {
  it("stands between the AppProjects and the registration — the grant exists before an Application does", () => {
    const names = makeCreateTenantDef(ports()).steps(createParams()).map((s) => s.name);
    expect(names.indexOf("provision-argo-sync")).toBe(names.indexOf("apply-appprojects") + 1);
    expect(names.indexOf("provision-argo-sync")).toBeLessThan(names.indexOf("write-registration"));
  });

  it("names this tenant's member Applications and arms the units that build its images", async () => {
    const buildRbac = new FakeBuildRbacWriter();
    const p = createParams();
    const step = makeCreateTenantDef(ports({ buildRbac })).steps(p).find((s) => s.name === "provision-argo-sync")!;
    await step.run(ctx(p, []));
    expect(roleOf(buildRbac)?.rules[0]!.resourceNames).toEqual(tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], GUID, "prod"));
    // The pipeline SA of the unit that builds the tenant's engine image — a tenant runs no release of
    // its own, so this is the identity that syncs it.
    expect(bindingOf(buildRbac)?.subjects).toEqual([
      { kind: "ServiceAccount", name: BUILD_PIPELINE_SERVICE_ACCOUNT, namespace: "example-platform-build" },
    ]);
  });

  it("is idempotent on a resume — the second write replaces the same two objects", async () => {
    const buildRbac = new FakeBuildRbacWriter();
    const p = createParams();
    const step = makeCreateTenantDef(ports({ buildRbac })).steps(p).find((s) => s.name === "provision-argo-sync")!;
    await step.run(ctx(p, []));
    await step.run(ctx(p, []));
    expect(buildRbac.keys()).toEqual([`Role s1/${GUID}-argo-sync`, `RoleBinding s1/${GUID}-argo-sync`]);
  });

  it("says plainly when NO unit attests a build the tenant pins — nothing may sync it, and the log says so", async () => {
    const buildRbac = new FakeBuildRbacWriter();
    const p = createParams({ syncUnits: [] });
    const logs: string[] = [];
    const step = makeCreateTenantDef(ports({ buildRbac })).steps(p).find((s) => s.name === "provision-argo-sync")!;
    await step.run(ctx(p, logs));
    expect(bindingOf(buildRbac)?.subjects).toEqual([]);
    expect(logs.some((l) => l.includes("NO subject"))).toBe(true);
  });
});

describe("planStream derives the subjects from the tenant's own images", () => {
  it("freezes only the units that attest a build this tenant pulls — a unit that builds none is left out", async () => {
    seedClusters();
    const docsWithImages = [
      ...CLEAN_DOCS,
      doc("Deployment", {
        raw: { kind: "Deployment", spec: { template: { spec: {
          containers: [
            { name: "engine", image: `${HOST}/example-engine:0.4.0` },
            { name: "cache", image: "docker.io/library/redis:7" }, // upstream, built by no unit of ours
          ],
        } } } },
      }),
    ];
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: docsWithImages } });
    const def = makeCreateTenantDef(ports({ helm }));
    const result = await def.planStream!({ clusterId: "cls_1", subdomain: "acme.example", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    // example-platform builds example-engine, which this tenant pulls; swissbookai builds nothing it
    // pulls, so its pipeline may not touch this tenant's Applications.
    expect(result.params.syncUnits).toEqual(["example-platform"]);
  });
});

describe("add-app extends the grant", () => {
  it("re-renders it over EVERY member — the live registration's apps plus the one being added", async () => {
    const buildRbac = new FakeBuildRbacWriter();
    const p = addParams();
    const step = makeAddAppDef(ports({ buildRbac, registry: await seededRegistry() })).steps(p).find((s) => s.name === "provision-argo-sync")!;
    await step.run(ctx(p, []));
    // A grant that shrank to the new member would leave every sibling Application unsyncable.
    expect(roleOf(buildRbac)?.rules[0]!.resourceNames).toEqual([
      `${GUID}-auth-prod`, `${GUID}-jobs-prod`, `${GUID}-report-prod`, `${GUID}-erp-prod`, `${GUID}-crm-prod`,
    ]);
  });

  it("runs before the append, so the new member's Application is never generated without a grant naming it", () => {
    const names = makeAddAppDef(ports()).steps(addParams()).map((s) => s.name);
    expect(names.indexOf("provision-argo-sync")).toBe(names.indexOf("apply-appproject") + 1);
    expect(names.indexOf("provision-argo-sync")).toBeLessThan(names.indexOf("append-app"));
  });
});
