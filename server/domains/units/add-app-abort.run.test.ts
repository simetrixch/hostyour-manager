import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { seedUnitSizes } from "./unit-size.ts";
import { eq, and } from "drizzle-orm";
import { pino } from "pino";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRunDefinitions } from "../runs/run-definitions.ts";
import { getRun } from "../../executor/read.ts";
import { makeAddAppDef } from "./add-app.run.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import type { ClusterStageResolver } from "./registrations.ts";
import { memberApplication } from "./tenant-fanout.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { AnyRunDefinition } from "../../executor/types.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

// ABORT-WITH-CLEANUP on an add-app run, driven through the REAL executor — the member-scoped sibling
// of create-tenant-abort.run.test.ts. The compensation (revert-app-append) is destructive by cascade:
// dropping the apps[] entry prunes the member's Application, the prune deletes its ServiceClaim, and
// the service-provisioner drops the member's databases with its user. So an abort must be REFUSED when
// the NEW member is live — keyed on the member, never on the tenant, because add-app only ever targets
// a live tenant and the tenant-level rule would refuse every add-app abort.

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const NEW_APP = "crm";
const EXPECTED = [memberApplication(GUID, NEW_APP, "prod")];
const REGISTRY_HOST = "zot.m1.example";
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";

const logger = pino({ level: "silent" });
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh"));
const fakeCreds = { open: async () => Buffer.from("x", "utf8") } as unknown as CredentialStore;
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
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}-${NEW_APP}`, raw: { kind }, ...over,
});
const CLEAN_DOCS = [doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }), doc("Deployment")];

let db: DbHandle;
// The size table is seeded at BOOT (boot/wire.ts), not by the migration, so an in-memory database
// starts without it — and write-pointer resolves the tenant's ceiling against it.
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

function seededPlatformRepo(): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  const registration = TenantRegistrationSchema.parse({ cluster: "s1", members: testMembers([{ name: "erp" }]), identityProvider: "auth", subdomain: "acme.example", apps: [{ name: "erp" }], quota: seedQuota("small") });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return repo;
}

interface Harness {
  executor: Executor;
  registrations: TenantRegistrations;
  argo: FakeMasterArgoReader;
}

function harness(): Harness {
  const registrations = new TenantRegistrations(seededPlatformRepo(), CLUSTER_STAGE);
  const argo = new FakeMasterArgoReader({});
  const ports: TenantOnboardPorts = {
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: CLEAN_DOCS } }),
    registrations,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({
        deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 },
        smoke: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "crm-engine", available: true, desired: 1, ready: 1 }], externalSecretsReady: true },
      }),
      argoReader: argo,
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  endpoints:\n    registry:\n      host: ${REGISTRY_HOST}\n` }],
    registryProbe: new FakeRegistryProbe(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }],
    consumerNames: async () => [],
  };
  const def = makeAddAppDef(ports) as unknown as AnyRunDefinition;
  const executor = new Executor({ db: db.db, creds: fakeCreds, bus: new RunEventBus(), logger, runDefinitions: buildRunDefinitions({ db: db.db }, [def]), sshFactory: noSsh, actor: () => "op_system" });
  return { executor, registrations, argo };
}

function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme.example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "active" }).run();
  db.db.insert(tenantApps).values({ id: "tna_1", tenantId: "tnt_1", name: "erp", status: "active" }).run();
}

/** Plan + approve + settle an add-app run that FAILS at watch-sync-set: the fake argo scripts no
 *  member statuses, so the new member's Application reads Missing and the set-watch refuses — the
 *  append is committed, the row is not. */
async function runFailingAddApp(h: Harness): Promise<string> {
  const { runId } = await h.executor.planStreamed("tenant-add-app", { tenantId: "tnt_1", app: NEW_APP });
  await h.executor.settle(runId);
  expect(getRun(db.db, runId)?.status).toBe("planned");
  await h.executor.approve(runId);
  await h.executor.settle(runId);
  expect(getRun(db.db, runId)?.status).toBe("failed");
  expect(getRun(db.db, runId)?.steps.find((s) => s.name === "watch-sync-set")?.status).toBe("failed");
  return runId;
}

const registeredApps = async (h: Harness): Promise<string[]> =>
  ((await h.registrations.readTenant("prod", GUID))?.entry.apps ?? []).map((a: { name: string }) => a.name);
const crmRow = () => db.db.select().from(tenantApps).where(and(eq(tenantApps.tenantId, "tnt_1"), eq(tenantApps.name, NEW_APP))).get();

const LIVE: ArgoAppStatus = { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" };

describe("aborting an add-app run whose NEW member went LIVE", () => {
  it("is REFUSED — the rollback would drop the member and its databases", async () => {
    // The watch timed out while the member was still converging; it converged after the budget and
    // is serving by the time anyone aborts. The guard reads the member's Application back and refuses.
    seedClusters();
    const h = harness();
    const runId = await runFailingAddApp(h);

    h.argo.setStatus(LIVE); // what getApplication answers for the member at abort time
    await expect(h.executor.abortWithCleanup(runId)).rejects.toThrow(/LIVE on the cluster.*drops the member's databases/s);

    // Nothing was scheduled and nothing ran: the appended app is still registered, the run untouched.
    expect(await registeredApps(h)).toEqual(["erp", NEW_APP]);
    expect(getRun(db.db, runId)?.status).toBe("failed");
    expect(getRun(db.db, runId)?.steps.some((s) => s.name.startsWith("cleanup:"))).toBe(false);
  });

  it("is REFUSED once record-inventory settled the member active, whatever ArgoCD answers", async () => {
    seedClusters();
    const h = harness();
    const runId = await runFailingAddApp(h);
    // A later retry (or a concurrent actor) settled the row — the product now advertises the member.
    db.db.insert(tenantApps).values({ id: "tna_2", tenantId: "tnt_1", name: NEW_APP, status: "active" }).run();

    await expect(h.executor.abortWithCleanup(runId)).rejects.toThrow(/recorded active.*data loss on a member that is serving/s);
    expect(await registeredApps(h)).toEqual(["erp", NEW_APP]);
  });

  it("the retry is the reconciliation: it records the live member and the run settles green", async () => {
    seedClusters();
    const h = harness();
    const runId = await runFailingAddApp(h);

    h.argo.setStatus(LIVE);
    h.argo.setStatuses(new Map(EXPECTED.map((n) => [n, LIVE]))); // the set-watch now converges
    await expect(h.executor.abortWithCleanup(runId)).rejects.toThrow(/Retry the run from its failed step/);

    await h.executor.retryFromStep(runId);
    await h.executor.settle(runId);
    expect(getRun(db.db, runId)?.status).toBe("succeeded");
    expect(crmRow()?.status).toBe("active"); // the inventory now says what the cluster does
  });
});

describe("aborting an add-app run whose member never came up", () => {
  it("still reverts the append — the state the abort exists for", async () => {
    seedClusters();
    const h = harness();
    const runId = await runFailingAddApp(h);
    expect(await registeredApps(h)).toEqual(["erp", NEW_APP]); // the append is committed

    // The member reads Missing at abort time (never converged, nothing serves) — the abort may run.
    await h.executor.abortWithCleanup(runId);
    await h.executor.settle(runId);

    expect(getRun(db.db, runId)?.status).toBe("cancelled");
    expect(getRun(db.db, runId)?.steps.find((s) => s.name === "cleanup:revert-app-append")?.status).toBe("ok");
    expect(await registeredApps(h)).toEqual(["erp"]); // the appended entry is gone, the sibling stands
  });
});
