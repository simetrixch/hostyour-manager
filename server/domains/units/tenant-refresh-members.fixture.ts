import { expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { seedUnitSizes } from "#unit/server/unit-size.ts";
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
import { testMembers, APP_OVERLAYS, TEST_BUNDLE, TEST_CHANNEL_STAGES, TEST_RESOURCES } from "./tenant-members.fixture.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { TEMPLATE_SPEC, withAppsTemplate, recordTestOwners } from "./tenant-apps-repo.fixture.ts";

// The books branch, ports and step contexts every test of the refresh-members run stands on.

export const SHA = "a".repeat(40);
export const GUID = "zsjs023ctne0";
const REGISTRY_HOST = "zot.m1.example";
const MEMBERS = ["auth", "jobs", "report", "erp"];
const EXPECTED = MEMBERS.map((m) => memberApplication(GUID, m, "prod"));

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
    - { name: auth, chart: charts/example-auth, identityProvider: true, namespaceLabels: { platform/redis-consumer: "true" } }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
${TEMPLATE_SPEC}  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;

const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({ apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}-erp`, raw: { kind }, ...over });

export let db: DbHandle;
/** A fresh in-memory database per test, the one every helper here reads; a test file calls this once. */
export function useMemoryDb(): void {
  beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); seedUnitSizes(db.db); });
  afterEach(() => { db.sqlite.close(); });
}

/** The erp member as a registration written before the product renamed its front chart. */
export function staleMembers(): TenantMemberRecord[] {
  return testMembers(["erp"]).map((m) => (m.name === "erp" ? { ...m, sources: [m.sources[0]!, { chart: "charts/old-ui", valueFiles: [], values: {} }] } : m));
}

/** The books branch: `earlier` is what releases wrote before `files`, which stands now. */
/** The registration's apps as create-tenant writes them: each with the database list its catalog entry declares. */
const LISTED_APPS: { name: string; databases?: string[] }[] = [{ name: "erp", databases: ["core", "sales"] }];

function platformRepo(members: TenantMemberRecord[], files: Record<string, string> = {}, earlier: Record<string, string> = {}, apps = LISTED_APPS): FakePlatformRepo {
  const repo = new FakePlatformRepo();
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members, identityProvider: "auth", apps, quota: seedQuota("small"), approvedTags: HELD, ...TEST_BUNDLE,
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  for (const [path, content] of Object.entries(earlier)) repo.seed(repo.booksBranch, path, content);
  for (const [path, content] of Object.entries(files)) repo.seed(repo.booksBranch, path, content);
  return repo;
}

export const OLD = "0.1.11-stable-20260920120000-def5678";
export const NEW = "0.1.12-stable-20260925120000-abc1234";
/** A version released before the one the tenant holds. */
export const OLDER = "0.1.10-stable-20260915120000-0a1b2c3";
/** An earlier release pinned OLDER at prod, before RELEASED pinned NEW. */
export const RELEASED_BEFORE = {
  "charts/example-engine/pins-prod.yaml": `builds:
  - { name: example-engine, image: example-engine, tag: "${OLDER}" }
`,
};
/** The version the tenant holds before any upgrade. */
export const HELD = { erp: { "example-engine": OLD } };
/** A release made NEW available: the stage pin of the engine and of the auth chart. */
export const RELEASED = {
  "charts/example-engine/pins-prod.yaml": `builds:
  - { name: example-engine, image: example-engine, tag: "${NEW}" }
`,
  "charts/example-auth/pins-prod.yaml": `builds:
  - { name: example-auth, image: example-auth, tag: "${NEW}" }
`,
};

export const DEPLOY_URL = "https://github.com/acme/acme-deploy.git";
/** The member entries the last plan resolved — what "the new entries" means to the fakes below. */
export let resolved: TenantMemberRecord[] = [];

/** Every member Application Synced + Healthy, its last comparison rendering `members` (by index,
 *  in the order the plan lists the Applications): the chart sources off the deploy repository, their value
 *  files and values, the tenant's versions, and the namespace labels on the spec. */
export function rendering(members: readonly TenantMemberRecord[], approved: Record<string, Record<string, string>> = HELD): Map<string, ArgoAppStatus> {
  return new Map(EXPECTED.map((name, i) => {
    const m = members[i]!;
    return [name, {
      syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy",
      namespaceLabels: { "platform/tenant": GUID, ...m.namespaceLabels, "platform/tenant-stage": "prod" },
      syncSources: [
        { repoURL: "https://github.com/simetrixch/hostyour-cloud.git", revision: SHA },
        { repoURL: DEPLOY_URL, revision: SHA },
        ...m.sources.map((src) => ({ repoURL: DEPLOY_URL, revision: SHA, path: src.chart, valueFiles: ["values.yaml", ...src.valueFiles], valuesObject: { tenant: { guid: GUID, approvedTags: approved }, ...src.values } })),
      ],
    } as ArgoAppStatus];
  }));
}

/** The member Applications as the live set-watch sees them over time, one scripted answer per read
 *  (the last one repeats), each asked for when read so it can name the entries the plan resolved. */
class SteppingArgo extends FakeMasterArgoReader {
  private reads = 0;
  constructor(private readonly answers: readonly (() => Map<string, ArgoAppStatus>)[]) { super(); }
  override async watchApplicationSet(namespace: string, names: readonly string[]): Promise<ArgoAppStatusMap> {
    this.operations.push(`watch-set:${namespace}/${names.join(",")}`);
    return this.answers[Math.min(this.reads++, this.answers.length - 1)]!();
  }
}

/** The member Applications of a tenant whose held images are gone from the registry: Degraded while
 *  the registration holds HELD, Synced + Healthy rendering `members` and the versions once it holds others. */
export class HeldImagesGoneArgo extends FakeMasterArgoReader {
  constructor(private readonly tenantRegistrations: TenantRegistrations, private readonly members: readonly TenantMemberRecord[]) { super(); }
  override async watchApplicationSet(): Promise<ArgoAppStatusMap> {
    const approved = (await this.tenantRegistrations.readTenant("prod", GUID))!.entry.approvedTags;
    const held = JSON.stringify(approved) === JSON.stringify(HELD);
    return new Map([...rendering(this.members, approved)].map(([name, s]) => [name, held ? { ...s, health: "Degraded" } : s]));
  }
}

const IMAGE = `${REGISTRY_HOST}/example-app:1.0.0`;
const DEPLOYMENT = { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "app", image: IMAGE, resources: TEST_RESOURCES }] } } } };

export function ports(members: TenantMemberRecord[], over: { missing?: string[]; argo?: readonly (() => Map<string, ArgoAppStatus>)[]; argoReader?: (tenantRegistrations: TenantRegistrations) => FakeMasterArgoReader; carried?: string[]; carry?: () => Promise<void>; manifest?: string; files?: Record<string, string>; earlier?: Record<string, string>; apps?: { name: string; databases?: string[] }[] } = {}): TenantOnboardPorts {
  const tenantRegistrations = new TenantRegistrations(platformRepo(members, over.files, over.earlier, over.apps));
  return withAppsTemplate({
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: over.manifest ?? MANIFEST_YAML, ...APP_OVERLAYS } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: [doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }), doc("Deployment", { raw: DEPLOYMENT })] } }),
    registrations: tenantRegistrations,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
      argoReader: over.argoReader?.(tenantRegistrations) ?? new SteppingArgo(over.argo ?? [() => rendering(resolved)]),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    deployRepoUrl: DEPLOY_URL,
    platformRepoURL: "https://github.com/simetrixch/hostyour-cloud.git",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: ${REGISTRY_HOST}\n` }],
    registryProbe: new FakeRegistryProbe({ missing: over.missing ?? [] }),
    carryTrunkToBooksBranch: over.carry ?? (async () => { over.carried?.push("carried"); }),
    buildRbac: new FakeBuildRbacWriter(),
    channelStages: async () => TEST_CHANNEL_STAGES,
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }],
    consumerHostLabels: async () => ["example-platform"],
  } as unknown as TenantOnboardPorts);
}

export function seedTenant(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "active" }).run();
  db.db.insert(tenantApps).values({ id: "tna_1", tenantId: "tnt_1", name: "erp" }).run();
}

export const planCtx = (): PlanStreamCtx => ({ db: db.db, log: () => undefined, signal: new AbortController().signal });

export function stepCtx(p: TenantRefreshMembersParams, cleanups: Cleanup[], logs: string[]): StepCtx {
  return {
    runId: "run_refresh", stepName: "x", db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: (c) => cleanups.push(c),
  };
}

export async function planned(prt: TenantOnboardPorts): Promise<TenantRefreshMembersParams> {
  const result = await makeTenantRefreshMembersDef(prt).planStream!({ tenantId: "tnt_1" }, planCtx());
  if (result.outcome !== "planned") throw new Error(`rejected: ${result.summary}`);
  resolved = result.params.members;
  expect(result.plan.summary).toMatch(/erp \(charts\/example-engine \+ charts\/old-ui → charts\/example-engine \+ charts\/example-ui\)/);
  return result.params;
}
