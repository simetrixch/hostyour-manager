import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { seedUnitSizes } from "./unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeTenantRefreshMembersDef, rendersEntry, type TenantRefreshMembersParams } from "./tenant-refresh-members.run.ts";
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
import { buildUnitStepName } from "./tenant-builds.ts";

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

const CATALOG = "https://github.com/acme/acme-catalog.git";
/** The member entries the last plan resolved — what "the new entries" means to the fakes below. */
let resolved: TenantMemberRecord[] = [];

/** Every member Application Synced + Healthy, its last comparison rendering `members` (by index,
 *  in the order the plan lists the Applications): the chart sources off the catalog, their value
 *  files and values, and the namespace labels on the spec. */
function rendering(members: readonly TenantMemberRecord[]): Map<string, ArgoAppStatus> {
  return new Map(EXPECTED.map((name, i) => {
    const m = members[i]!;
    return [name, {
      syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy",
      namespaceLabels: { "platform/tenant": GUID, ...m.namespaceLabels },
      syncSources: [
        { repoURL: "https://github.com/simetrixch/hostyour-cloud.git", revision: SHA },
        { repoURL: CATALOG, revision: SHA },
        ...m.sources.map((src) => ({ repoURL: CATALOG, revision: SHA, path: src.chart, valueFiles: ["values.yaml", ...src.valueFiles], valuesObject: { tenant: { guid: GUID }, ...src.values } })),
      ],
    } as ArgoAppStatus];
  }));
}

/** The member Applications as the live set-watch sees them over time, one scripted answer per read
 *  (the last one repeats), each asked for when read so it can name the entries the plan resolved. */
class SteppingArgo extends FakeMasterArgoReader {
  private reads = 0;
  constructor(private readonly answers: readonly (() => Map<string, ArgoAppStatus>)[]) { super(); }
  override async watchApplicationSet(): Promise<ArgoAppStatusMap> {
    return this.answers[Math.min(this.reads++, this.answers.length - 1)]!();
  }
}

const IMAGE = `${REGISTRY_HOST}/example-app:1.0.0`;
const DEPLOYMENT = { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "app", image: IMAGE }] } } } };

function ports(members: TenantMemberRecord[], over: { missing?: string[]; argo?: readonly (() => Map<string, ArgoAppStatus>)[]; carried?: string[]; carry?: () => Promise<void>; manifest?: string } = {}): TenantOnboardPorts {
  return withAppsTemplate({
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: over.manifest ?? MANIFEST_YAML, ...APP_OVERLAYS } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: [doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }), doc("Deployment", { raw: DEPLOYMENT })] } }),
    registrations: new TenantRegistrations(platformRepo(members)),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
      argoReader: new SteppingArgo(over.argo ?? [() => rendering(resolved)]),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: CATALOG,
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

function stepCtx(p: TenantRefreshMembersParams, cleanups: Cleanup[], logs: string[]): StepCtx {
  return {
    runId: "run_refresh", stepName: "x", db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: (c) => cleanups.push(c),
  };
}

async function planned(prt: TenantOnboardPorts): Promise<TenantRefreshMembersParams> {
  const result = await makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1" }, planCtx());
  if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
  resolved = result.params.members;
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

  it("builds a missing image the product's buildRepos names ahead of ensure-images, and refuses one nobody builds", async () => {
    seedTenant();
    const PLATFORM_REPO = "https://github.com/acme/example-platform.git";
    const withRepos = ports(staleMembers(), { missing: ["example-app:1.0.0"], manifest: MANIFEST_YAML.replace("  members:", `  buildRepos:
    - repo: ${PLATFORM_REPO}
      builds: [example-app]
  members:`) });
    const p = await planned(withRepos);
    expect(p.buildUnits).toEqual([{ unit: "example-platform", repoURL: PLATFORM_REPO, images: ["example-app"], registered: false }]);
    const names = makeTenantRefreshMembersDef(withRepos).steps(p).map((s) => s.name);
    expect(names.indexOf(buildUnitStepName("example-platform"))).toBe(1);
    expect(names.indexOf(buildUnitStepName("example-platform"))).toBeLessThan(names.indexOf("ensure-images"));
    expect(names.indexOf("ensure-images")).toBeLessThan(names.indexOf("write-members"));
    const nobody = await makeTenantRefreshMembersDef(ports(staleMembers(), { missing: ["example-app:1.0.0"] })).planStream!({ tenantId: "tnt_1" }, planCtx());
    expect(nobody.outcome).toBe("rejected");
    if (nobody.outcome === "rejected") expect(nobody.summary).toMatch(/buildRepos names no repository.*example-app:1\.0\.0/);
  });

  it("does not take a member Synced + Healthy on its old entry for one that rendered the new entry", async () => {
    seedTenant();
    const prt = ports(staleMembers(), { argo: [() => rendering(staleMembers())] });
    const p = await planned(prt);
    const watch = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "watch-sync-set")!;
    await expect(watch.run(stepCtx(p, [], []))).rejects.toThrow(/auth, erp are Synced \+ Healthy but ArgoCD has not rendered the new entries yet/);
  });

  it("does not take a render whose values or namespace labels still differ from the new entry", async () => {
    seedTenant();
    const prt = ports(staleMembers(), { argo: [() => rendering(resolved.map((m) => (m.name === "auth" ? { ...m, namespaceLabels: {} } : m)))] });
    const p = await planned(prt);
    const watch = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "watch-sync-set")!;
    await expect(watch.run(stepCtx(p, [], []))).rejects.toThrow(/auth is Synced/);
  });

  it("refuses a render that still carries a dropped value file and value or lacks a chart, and takes one with an extra value or label nobody named", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const watch = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "watch-sync-set")!;
    const erpAt = p.members.findIndex((m) => m.name === "erp");
    const withErp = (erp: TenantMemberRecord): (() => Map<string, ArgoAppStatus>) => () => rendering(p.members.map((m, i) => (i === erpAt ? erp : m)));
    const erp = p.members[erpAt]!;
    const was = p.previous.find((m) => m.name === "erp")!;
    // The previous erp engine carried a value file and a value the new entry drops: still rendered, not synced.
    const stale = { ...erp, sources: [{ ...erp.sources[0]!, valueFiles: was.sources[0]!.valueFiles, values: was.sources[0]!.values }, erp.sources[1]!] };
    const cases: TenantMemberRecord[] = [
      stale,
      { ...erp, sources: [{ ...erp.sources[0]!, values: { ...erp.sources[0]!.values, extra: 1 } }, erp.sources[1]!] }, // extra is harmless only when neither side named it
      { ...erp, sources: [erp.sources[0]!] },
      { ...erp, namespaceLabels: { ...erp.namespaceLabels, gone: "yes" } },
    ];
    const verdicts: boolean[] = [];
    for (const c of cases) {
      const run = makeTenantRefreshMembersDef(ports(staleMembers(), { argo: [withErp(c)] })).steps(p).find((s) => s.name === "watch-sync-set")!;
      verdicts.push(await run.run(stepCtx(p, [], [])).then(() => true, () => false));
    }
    expect(verdicts).toEqual([false, true, false, true]);
    await expect(watch.run(stepCtx(p, [], []))).resolves.toBeUndefined();
  });

  it("write-members resumed after its own write commits nothing new, keeps its cleanup and stamps the tenant row", async () => {
    seedTenant();
    const prt = ports(staleMembers());
    const p = await planned(prt);
    const write = makeTenantRefreshMembersDef(prt).steps(p).find((s) => s.name === "write-members")!;
    const cleanups: Cleanup[] = [];
    await write.run(stepCtx(p, cleanups, []));
    await write.run(stepCtx(p, cleanups, []));
    expect(cleanups.map((c) => c.name)).toEqual(["restore-members", "restore-members"]);
    expect(db.db.select({ r: tenants.lastRunId }).from(tenants).get()?.r).toBe("run_refresh");
  });

  it("fails the plan when the catalog trunk cannot be carried: it never plans over a stale books branch", async () => {
    seedTenant();
    const prt = ports(staleMembers(), { carry: async () => { throw new Error("push rejected"); } });
    await expect(makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1" }, planCtx())).rejects.toThrow(/push rejected/);
  });

  it("REFUSES the abort once every member renders the new entries; the restore leaves entries another run wrote", async () => {
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
    const prt = ports(staleMembers(), { argo: [() => rendering(staleMembers())] });
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

describe("rendersEntry, clause by clause", () => {
  const src = (over: Partial<TenantMemberRecord["sources"][number]> = {}): TenantMemberRecord["sources"][number] => ({ chart: "charts/x", valueFiles: [], values: {}, ...over });
  const entry = (over: Partial<TenantMemberRecord> = {}): TenantMemberRecord => ({ name: "erp", namespaceLabels: {}, sources: [src()], ...over });
  const render = (m: TenantMemberRecord, labels: Record<string, string> = {}): ArgoAppStatus => ({
    syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy", namespaceLabels: labels,
    syncSources: m.sources.map((s) => ({ repoURL: CATALOG, revision: SHA, path: s.chart, valueFiles: ["values.yaml", ...s.valueFiles], valuesObject: { tenant: {}, ...s.values } })),
  });
  it("holds the entry's value files in their order, searched after the template's own", () => {
    const want = entry({ sources: [src({ valueFiles: ["a.yaml", "values.yaml"] })] });
    expect(rendersEntry(render(want), want, undefined, CATALOG)).toBe(true);
    const swapped = entry({ sources: [src({ valueFiles: ["values.yaml", "a.yaml"] })] });
    expect(rendersEntry(render(entry({ sources: [src({ valueFiles: ["b.yaml", "a.yaml"] })] })), entry({ sources: [src({ valueFiles: ["a.yaml", "b.yaml"] })] }), undefined, CATALOG)).toBe(false);
    expect(rendersEntry(render(swapped), swapped, undefined, CATALOG)).toBe(true);
  });
  it("refuses a value file the previous entry had and the new one dropped", () => {
    const was = entry({ sources: [src({ valueFiles: ["old.yaml"] })] });
    expect(rendersEntry(render(was), entry(), was, CATALOG)).toBe(false);
    expect(rendersEntry(render(entry()), entry(), was, CATALOG)).toBe(true);
  });
  it("refuses a value key the previous entry had and the new one dropped", () => {
    const was = entry({ sources: [src({ values: { debug: true } })] });
    expect(rendersEntry(render(was), entry(), was, CATALOG)).toBe(false);
    expect(rendersEntry(render(entry()), entry(), was, CATALOG)).toBe(true);
  });
  it("refuses a namespace label the previous entry had and the new one dropped, and a label of another value", () => {
    const was = entry({ namespaceLabels: { stale: "yes" } });
    expect(rendersEntry(render(entry(), { stale: "yes" }), entry(), was, CATALOG)).toBe(false);
    expect(rendersEntry(render(entry(), {}), entry(), was, CATALOG)).toBe(true);
    const want = entry({ namespaceLabels: { tier: "b" } });
    expect(rendersEntry(render(want, { tier: "a" }), want, undefined, CATALOG)).toBe(false);
  });
});
