import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { seedUnitSizes } from "./unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeTenantRefreshMembersDef, type TenantRefreshMembersParams } from "./tenant-refresh-members.run.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { memberApplication } from "./tenant-fanout.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { TenantRegistrationSchema, type TenantMemberRecord } from "../../../shared/tenant.ts";
import type { StepCtx, PlanStreamCtx, Cleanup } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ArgoAppStatus, ArgoAppStatusMap } from "../../adapters/kube/port.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import { testMembers, APP_OVERLAYS, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { TEMPLATE_SPEC, withAppsTemplate, recordTestOwners } from "./tenant-apps-repo.fixture.ts";

// tenant-refresh-members: the plan resolves the members again off the product's manifest and names
// what changes, refuses a tenant with nothing to change or a changed member set, and the steps write
// the entries and wait for the sync; an abort writes the previous entries back.

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const REGISTRY_HOST = "zot.m1.example";
const MEMBERS = ["auth", "jobs", "report", "erp"];
const EXPECTED = MEMBERS.map((m) => memberApplication(GUID, m, "prod"));

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

const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({ apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}-erp`, raw: { kind }, ...over });

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

/** The erp member as a registration written before the product renamed its front chart. */
function staleMembers(): TenantMemberRecord[] {
  return testMembers(["erp"]).map((m) => (m.name === "erp" ? { ...m, sources: [m.sources[0]!, { chart: "charts/old-ui", valueFiles: [], values: {} }] } : m));
}

function platformRepo(members: TenantMemberRecord[]): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members, identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"), ...TEST_BUNDLE,
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return repo;
}

const BEFORE = "b".repeat(40);
const AFTER = "c".repeat(40);

function synced(revision = AFTER): Map<string, ArgoAppStatus> {
  return new Map(EXPECTED.map((n) => [n, { syncRevision: revision, targetRevision: null, sync: "Synced", health: "Healthy" } as ArgoAppStatus]));
}

/** The member Applications as the live set-watch sees them over time: the first read answers the
 *  revision they stand at before the write, every later one the next scripted answer (the last one
 *  repeats). Models ArgoCD rendering the new entries after the write. */
class SteppingArgo extends FakeMasterArgoReader {
  private reads = 0;
  constructor(private readonly answers: readonly Map<string, ArgoAppStatus>[]) { super(); }
  override async watchApplicationSet(): Promise<ArgoAppStatusMap> {
    return new Map(this.answers[Math.min(this.reads++, this.answers.length - 1)]);
  }
}

const IMAGE = `${REGISTRY_HOST}/example-app:1.0.0`;
const DEPLOYMENT = { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "app", image: IMAGE }] } } } };

function ports(members: TenantMemberRecord[], over: { missing?: string[]; argo?: readonly Map<string, ArgoAppStatus>[]; carried?: string[]; carry?: () => Promise<void> } = {}): TenantOnboardPorts {
  return withAppsTemplate({
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML, ...APP_OVERLAYS } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: [doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }), doc("Deployment", { raw: DEPLOYMENT })] } }),
    registrations: new TenantRegistrations(platformRepo(members)),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
      argoReader: new SteppingArgo(over.argo ?? [synced(BEFORE), synced(AFTER)]),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: "https://github.com/acme/acme-catalog.git",
    platformRepoURL: "https://github.com/simetrixch/hostyour-cloud.git",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: ${REGISTRY_HOST}\n` }],
    registryProbe: new FakeRegistryProbe({ missing: over.missing ?? [] }),
    carryTrunkToBooksBranch: over.carry ?? (async () => { over.carried?.push("carried"); }),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }],
    consumerHostLabels: async () => ["example-platform"],
  } as unknown as TenantOnboardPorts);
}

function seedTenant(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "active" }).run();
  db.db.insert(tenantApps).values({ id: "tna_1", tenantId: "tnt_1", name: "erp" }).run();
}

const planCtx = (): PlanStreamCtx => ({ db: db.db, log: () => undefined, signal: new AbortController().signal });

/** A step context whose checkpoint survives between two runs of one step when handed the same box. */
function stepCtx(p: TenantRefreshMembersParams, cleanups: Cleanup[], logs: string[], box: { data?: unknown } = {}): StepCtx {
  return {
    runId: "run_refresh", stepName: "x", db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: (d) => { box.data = d; }, readCheckpoint: <T>() => box.data as T | undefined, registerCleanup: (c) => cleanups.push(c),
  };
}

async function planned(prt: TenantOnboardPorts): Promise<TenantRefreshMembersParams> {
  const result = await makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1" }, planCtx());
  if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
  expect(result.plan.summary).toMatch(/erp \(charts\/example-engine \+ charts\/old-ui → charts\/example-engine \+ charts\/example-ui\)/);
  return result.params;
}

describe("tenant-refresh-members", () => {
  it("resolves a renamed chart, writes every member entry and waits for every member to sync", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const logs: string[] = [];
    for (const step of makeTenantRefreshMembersDef(prt).steps(p)) await step.run(stepCtx(p, [], logs));
    const erp = (await prt.registrations.readTenant("prod", GUID))?.entry.members.find((m) => m.name === "erp");
    expect(erp?.sources[1]?.chart).toBe("charts/example-ui");
    expect(logs.some((l) => l.includes("Synced + Healthy"))).toBe(true);
  });

  it("an abort writes the previous member entries back", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const cleanups: Cleanup[] = [];
    const write = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "write-members")!;
    await write.run(stepCtx(p, cleanups, []));
    for (const c of cleanups.reverse()) await c.run(stepCtx(p, [], []));
    const erp = (await prt.registrations.readTenant("prod", GUID))?.entry.members.find((m) => m.name === "erp");
    expect(erp?.sources[1]?.chart).toBe("charts/old-ui");
  });

  it("REFUSES a tenant whose entries already match the manifest: nothing is committed", async () => {
    seedTenant();
    const resolved = await planned(ports(staleMembers()));
    await expect(makeTenantRefreshMembersDef(ports(resolved.members)).planStream!({ tenantId: "tnt_1" }, planCtx())).rejects.toThrow(/nothing to refresh/);
  });

  it("REFUSES a manifest that changes the member set: that is a new namespace and Application", async () => {
    seedTenant();
    const fewer = staleMembers().filter((m) => m.name !== "report");
    await expect(makeTenantRefreshMembersDef(ports(fewer)).planStream!({ tenantId: "tnt_1" }, planCtx())).rejects.toThrow(/not a refresh/);
  });

  it("carries the catalog trunk into the books branch before it resolves anything", async () => {
    seedTenant();
    const carried: string[] = [];
    await planned(ports(staleMembers(), { carried }));
    expect(carried).toEqual(["carried"]);
  });

  it("REFUSES a manifest that moves the identity provider, and a suspended tenant", async () => {
    seedTenant();
    const moved = staleMembers();
    const prt = ports(moved);
    const entry = (await prt.registrations.readTenant("prod", GUID))!.entry;
    await prt.registrations.commitTenant({ stage: "prod", guid: GUID, runId: "run_x", registration: { ...entry, identityProvider: "jobs" } });
    await expect(makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1" }, planCtx())).rejects.toThrow(/moving the identity provider/);
    db.db.update(tenants).set({ suspended: true }).run();
    await expect(makeTenantRefreshMembersDef(ports(staleMembers())).planStream!({ tenantId: "tnt_1" }, planCtx())).rejects.toThrow(/suspended/);
  });

  it("fails at ensure-images, before any entry is written, when an image of the new render is not in the registry", async () => {
    seedTenant();
    const prt = ports(staleMembers(), { missing: ["example-app:1.0.0"] });
    const p = await planned(prt);
    expect(p.requiredImages.length).toBeGreaterThan(0);
    const steps = makeTenantRefreshMembersDef(prt).steps(p);
    const ensure = steps.find((s) => s.name === "ensure-images")!;
    await expect(ensure.run(stepCtx(p, [], []))).rejects.toThrow(/example-app/);
  });

  it("does not take a member that was Synced + Healthy before the write for one that synced it", async () => {
    seedTenant();
    const prt = ports(staleMembers(), { argo: [synced(BEFORE)] });
    const p = await planned(prt);
    const write = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "write-members")!;
    await expect(write.run(stepCtx(p, [], []))).rejects.toThrow(/still read.*the catalog revision.*stood at before the write/);
  });

  it("write-members retried after its own write waits past the revisions it recorded before the write", async () => {
    seedTenant();
    // The first attempt reads the old revision before the write, then times out on it; the retry
    // must keep the revision it recorded then: read afresh after the write, it would take the new
    // revision for its starting point and wait for a move that already happened.
    const prt = ports(staleMembers(), { argo: [synced(BEFORE), synced(BEFORE), synced(AFTER)] });
    const p = await planned(prt);
    const write = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "write-members")!;
    const cleanups: Cleanup[] = [];
    const box = {};
    await expect(write.run(stepCtx(p, cleanups, [], box))).rejects.toThrow(/still read/);
    await write.run(stepCtx(p, cleanups, [], box));
    expect(cleanups.map((c) => c.name)).toEqual(["restore-members", "restore-members"]);
    expect(db.db.select({ r: tenants.lastRunId }).from(tenants).get()?.r).toBe("run_refresh");
  });

  it("fails the plan when the catalog trunk cannot be carried: it never plans over a stale books branch", async () => {
    seedTenant();
    const prt = ports(staleMembers(), { carry: async () => { throw new Error("push rejected"); } });
    await expect(makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1" }, planCtx())).rejects.toThrow(/push rejected/);
  });

  it("REFUSES the abort once every member is Synced + Healthy at the new entries; the restore leaves entries another run wrote", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const def = makeTenantRefreshMembersDef(prt);
    const cleanups: Cleanup[] = [];
    await def.steps(p).find((s) => s.name === "write-members")!.run(stepCtx(p, cleanups, []));
    await expect(def.assertAbortable!(p, { db: db.db })).rejects.toThrow(/Retry the failed step/);
    const other = p.members.map((m) => (m.name === "erp" ? { ...m, namespaceLabels: { later: "yes" } } : m));
    await prt.registrations.setMembers("prod", GUID, other, "run_other");
    await cleanups[0]!.run(stepCtx(p, [], []));
    expect((await prt.registrations.readTenant("prod", GUID))?.entry.members.find((m) => m.name === "erp")?.namespaceLabels).toEqual({ later: "yes" });
  });

  it("allows the abort while the members have not converged", async () => {
    seedTenant();
    const prt = ports(staleMembers(), { argo: [synced(BEFORE), synced(AFTER), new Map()] });
    const p = await planned(prt);
    const def = makeTenantRefreshMembersDef(prt);
    await def.steps(p).find((s) => s.name === "write-members")!.run(stepCtx(p, [], []));
    await expect(def.assertAbortable!(p, { db: db.db })).resolves.toBeUndefined();
  });

  it("the write asks the plan's facts again: entries changed since the plan fail without writing", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const other = staleMembers().map((m) => (m.name === "erp" ? { ...m, namespaceLabels: { moved: "yes" } } : m));
    await prt.registrations.setMembers("prod", GUID, other, "run_other");
    const write = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "write-members")!;
    await expect(write.run(stepCtx(p, [], []))).rejects.toThrow(/changed since this run was planned/);
  });
});
