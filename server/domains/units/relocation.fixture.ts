// Shared fixture of the relocation run tests (backup / restore / migrate, both kinds): two prod
// clusters (s1 = source, s2 = target), one consumer and one tenant seeded on the source, and
// the fake port sets the runs drive — per-cluster kube fakes behind one resolver, the in-memory
// registries over a fake platform repo, the DNS fake with both clusters' own A records, and the
// public probe defaulting to "unreachable" (what a correctly quiesced unit answers).
import { openDb, type DbHandle } from "../../db/client.ts";
import { seedQuota } from "../../../shared/unit-size.ts";
import { servers, clusters, apps, tenants, tenantApps } from "../../db/schema/inventory.ts";
import type { StepCtx, Step } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { Stage, AppStatus, TenantStatus } from "../../../shared/enums.ts";
import type { ConsumerService } from "../../../shared/consumer.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePublicProbe } from "../../adapters/http-probe/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter, FakeRepoCredentialWriter } from "../../adapters/kube/testing/fake.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { tenantApplicationSet } from "./tenant-fanout.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import type { ConsumerRelocationPorts } from "./relocation-world-consumer.ts";
import type { TenantRelocationPorts } from "./relocation-world-tenant.ts";
import { testMembers } from "./tenant-members.fixture.ts";

const SHA = "a".repeat(40);
export const GUID = "zsjs023ctne0";
export const SUBDOMAIN = "acme";
export const CONSUMER = "acme";
export const SOURCE = { clusterId: "cls_1", domain: "s1.example", cluster: "s1", ip: "10.0.0.1" } as const;
export const TARGET = { clusterId: "cls_2", domain: "s2.example", cluster: "s2", ip: "10.0.0.2" } as const;
const BOX = { host: "box.example", user: "u100", password: "box-secret" } as const;
const DBTOOLS_IMAGE = "registrations.example/dbtools:1.0.0";
const TENANT_APPS = [{ name: "web" }];
/** The standing members of the fixture tenant — a set the fixture STATES, the way a real tenant's
 *  registration states its own. Three of them because that is what the product under test declares,
 *  not because the platform believes every tenant has three. */
const TENANT_MEMBERS = ["auth", "jobs", "report"];
const TENANT_IDP = "auth";
const TENANT_WATCH = tenantApplicationSet([...TENANT_MEMBERS, ...TENANT_APPS.map((a) => a.name)], GUID, "prod");

const marked: ClusterStageResolver = async (cluster: string) => {
  if (cluster !== "s1" && cluster !== "s2") throw new Error(`no cluster map for "${cluster}"`);
  return { name: cluster, stage: "prod" as Stage };
};

export function openFixtureDb(): DbHandle {
  return openDb(":memory:");
}

/** Both prod clusters, source + target. */
export function seedClusters(db: DbHandle): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: SOURCE.clusterId, serverId: "srv_1", stage: "prod", domain: SOURCE.domain, status: "active" }).run();
  db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "10.1.1.12", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: TARGET.clusterId, serverId: "srv_2", stage: "prod", domain: TARGET.domain, status: "active" }).run();
}

export function seedConsumerRow(db: DbHandle, status: AppStatus = "active"): void {
  db.db.insert(apps).values({ id: "app_1", clusterId: SOURCE.clusterId, name: CONSUMER, stage: "prod", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "controller", status }).run();
}

export function seedTenantRows(db: DbHandle, status: TenantStatus = "active"): void {
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: SOURCE.clusterId, guid: GUID, subdomain: SUBDOMAIN, stage: "prod", members: TENANT_MEMBERS, identityProvider: TENANT_IDP, status }).run();
  db.db.insert(tenantApps).values({ id: "tna_web", tenantId: "tnt_1", name: "web", status }).run();
}

export function tenantEntry(over: Partial<TenantRegistration> = {}): TenantRegistration {
  return {
    cluster: SOURCE.cluster,
    members: testMembers(TENANT_APPS),
    identityProvider: TENANT_IDP,
    subdomain: SUBDOMAIN,
    apps: TENANT_APPS.map((a) => ({ ...a, seedReference: false, seedDemo: false })),
    seedUsers: false, quota: seedQuota("small"),
    resetNonce: "1",
    suspended: false,
    quiesced: false,
    ...over,
  };
}

const synced: ArgoAppStatus = { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" };
export const missing: ArgoAppStatus = { syncRevision: null, targetRevision: null, sync: "Unknown", health: "Missing" };

/** Every expected fan-out name Synced/Healthy — what a converged tenant set-watch observes. */
function syncedSet(names: readonly string[]): Map<string, ArgoAppStatus> {
  return new Map(names.map((n) => [n, synced]));
}

/** One side of the world: a cluster's own reader + argo + project writer behind the resolver. */
export interface FakeSide {
  reader: FakeClusterReader;
  argo: FakeMasterArgoReader;
  projects: FakeMasterProjectWriter;
}

export interface RelocationFakes {
  source: FakeSide;
  target: FakeSide;
  resolver: FakeClusterKubeResolver;
  dns: FakeDnsProvider;
  probe: FakePublicProbe;
  buildRbac: FakeBuildRbacWriter;
  repoCredential: FakeRepoCredentialWriter;
  platformRepo: FakePlatformRepo;
}

export function makeFakes(): RelocationFakes {
  const source: FakeSide = {
    reader: new FakeClusterReader({ deployState: { domain: SOURCE.domain, stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
    argo: new FakeMasterArgoReader({ status: synced, statuses: syncedSet(TENANT_WATCH) }),
    projects: new FakeMasterProjectWriter(),
  };
  const target: FakeSide = {
    reader: new FakeClusterReader({ deployState: { domain: TARGET.domain, stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 1 } }),
    argo: new FakeMasterArgoReader({ status: synced, statuses: syncedSet(TENANT_WATCH) }),
    projects: new FakeMasterProjectWriter(),
  };
  const resolver = new FakeClusterKubeResolver({ clusterReader: source.reader, argoReader: source.argo, projectWriter: source.projects, argoNamespace: SOURCE.cluster });
  resolver.set(TARGET.clusterId, { clusterReader: target.reader, argoReader: target.argo, projectWriter: target.projects, argoNamespace: TARGET.cluster });
  const dns = new FakeDnsProvider();
  dns.seed(SOURCE.domain, "A", SOURCE.ip);
  dns.seed(TARGET.domain, "A", TARGET.ip);
  return {
    source,
    target,
    resolver,
    dns,
    probe: new FakePublicProbe(),
    buildRbac: new FakeBuildRbacWriter(),
    repoCredential: new FakeRepoCredentialWriter(),
    platformRepo: new FakePlatformRepo(),
  };
}

export function consumerPorts(f: RelocationFakes): ConsumerRelocationPorts & { registrations: Registrations } {
  const registrations = new Registrations(f.platformRepo, marked);
  return {
    registrations,
    resolver: f.resolver,
    argoWatchTimeoutMs: 1000,
    jobTimeoutMs: 1000,
    probe: f.probe,
    dns: f.dns,
    storageBox: { ...BOX },
    dbtoolsImage: DBTOOLS_IMAGE,
    platformRepoURL: "https://github.com/simetrixch/hostyour-cloud.git",
    buildRbac: f.buildRbac,
    repoCredential: f.repoCredential,
  };
}

export function tenantPorts(f: RelocationFakes): TenantRelocationPorts & { registrations: TenantRegistrations } {
  const registrations = new TenantRegistrations(f.platformRepo, marked);
  return {
    registrations,
    resolver: f.resolver,
    argoWatchTimeoutMs: 1000,
    jobTimeoutMs: 1000,
    probe: f.probe,
    dns: f.dns,
    storageBox: { ...BOX },
    dbtoolsImage: DBTOOLS_IMAGE,
    catalogRepoUrl: "https://github.com/simetrixch/catalog.git",
    platformRepoURL: "https://github.com/simetrixch/hostyour-cloud.git",
    buildRbac: f.buildRbac,
    resolveUnitApex: async () => "example.com",
  };
}

/** Seed the consumer registration the source serves — what backup/migrate dump and repoint. The
 *  claim scope is overridable because it decides which stores a relocation touches: the default is the
 *  one Mongo database the journeys move, and a test that pins a store-less or a PostgreSQL consumer
 *  passes its own `services`/`databases`. */
export async function seedConsumerRegistration(
  registrations: Registrations,
  over: { quiesced?: boolean; services?: ConsumerService[]; databases?: string[] } = {},
): Promise<void> {
  await registrations.commitRegistration({
    unit: { name: CONSUMER, repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: over.quiesced ?? false },
    builds: [],
    deploy: {
      stage: "prod",
      chartPath: "deploy/chart",
      cluster: SOURCE.cluster,
      databases: over.databases ?? ["acme_db"],
      services: over.services ?? ["mongodb"],
      size: "small", mongodb: "shared", quota: seedQuota("small"),
    },
    runId: "run_onb",
  });
}

/** Seed the tenant registration — the source world a move starts from. What the repoint releases is
 *  the fan-out it generates, not an object seeded here: the source appset stops matching once the
 *  registration's cluster field is flipped. */
export async function seedTenantWorld(registrations: TenantRegistrations): Promise<void> {
  await registrations.commitTenant({ stage: "prod", guid: GUID, registration: tenantEntry(), runId: "run_onb" });
}

export function stepCtx(db: DbHandle, stepName: string, p: Readonly<Record<string, unknown>>, logs: string[], runId = "run_reloc"): StepCtx {
  return {
    runId, stepName, db: db.db, creds: {} as unknown as CredentialStore, params: p,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

/** Drive steps in order; `before` lets a test flip a fake's scripted world at a named step (e.g.
 *  the source Application going Missing after the repoint). */
export async function driveSteps(db: DbHandle, steps: Step[], p: Readonly<Record<string, unknown>>, logs: string[], before: Partial<Record<string, () => void>> = {}): Promise<void> {
  for (const step of steps) {
    before[step.name]?.();
    await step.run(stepCtx(db, step.name, p, logs));
  }
}

/** The job names one side actually ran — what the choreography assertions read. */
export function jobNames(side: FakeSide): string[] {
  return side.reader.jobs.map((j) => j.spec.name);
}
