// The shared harness of the tenant lifecycle run tests: the seeded tenant, its registration, the
// fake kube behind the resolver, and the ArgoCD statuses a converged fan-out reports.
import { seedQuota } from "#unit/shared/unit-size.ts";
import { type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { type TenantLifecyclePorts } from "./lifecycle.ts";
import { tenantApplicationSet } from "./tenant-fanout.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import type { TenantStatus } from "../../../shared/enums.ts";
import { STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers } from "./tenant-members.fixture.ts";

export const SHA = "a".repeat(40);
export const GUID = "zsjs023ctne0"; // a live guid (matches the registrations/** path guard)
export const DEPLOY_REPO = "https://github.com/acme/acme-deploy.git";
export const PLATFORM_REPO = "https://github.com/simetrixch/hostyour-cloud.git";



// The registration carries no trio block of any kind: auth, jobs and report are members of EVERY
// tenant, so there is nothing to state and nothing to gate.
export function entry(over: Partial<TenantRegistration> = {}): TenantRegistration {
  return {
    cluster: "s1",
    members: testMembers(["erp"]),
    identityProvider: "auth", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "", displayName: "",
    subdomain: "example",
    apps: [{ name: "erp", seedReference: false, seedDemo: false, selections: {}, needs: [], path: "/app/erp" }],
    seedUsers: false, quota: seedQuota("small"),
    resetNonce: "1",
    suspended: false,
    quiesced: false,
    appsImage: "", appsImageTag: "",
    ...over,
  };
}

// The kube clients ride behind the resolver now: fold the per-test fakes (argo/cluster/
// projects) into a FakeClusterKubeResolver whose master path resolves to argoNamespace "argocd".
export type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

export function ports(reg: TenantRegistrations, over: Partial<TenantLifecyclePorts> & FakeKube = {}): TenantLifecyclePorts {
  const { argo, cluster, projects, ...portOver } = over;
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } }),
      argoReader: argo ?? new FakeMasterArgoReader(),
      projectWriter: projects ?? new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    deployRepoUrl: DEPLOY_REPO,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    dns: new FakeDnsProvider(),
    ...portOver,
  };
}



/** The scripted per-name statuses a converged (Synced/Healthy@SHA) fan-out reports. */
export function syncedMap(names: readonly string[], sha = SHA): Map<string, ArgoAppStatus> {
  const m = new Map<string, ArgoAppStatus>();
  for (const n of names) m.set(n, { syncRevision: sha, targetRevision: null, sync: "Synced", health: "Healthy" });
  return m;
}

/** A converged fan-out whose member sources of the deploy repository render `tenant.suspended` at
 *  `suspended`: what the members show once the ApplicationSet regenerated them from the flip. */
export function renderingMap(names: readonly string[], suspended: boolean): Map<string, ArgoAppStatus> {
  const m = new Map<string, ArgoAppStatus>();
  for (const n of names) {
    m.set(n, { syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy", syncSources: [{ repoURL: DEPLOY_REPO, revision: SHA, path: "charts/member", valuesObject: { tenant: { suspended } } }] });
  }
  return m;
}

// The full fan-out for the default seed (the trio + erp), computed via the SAME pure algebra the runs
// use — never hand-rolled (a drifting name hangs the watch forever).
export const FULL_SET = tenantApplicationSet([...TEST_MEMBERS, "erp"], GUID, "prod");

/** A smoke answer with ONE workload asking for `desired` replicas — the fake returns it for every
 *  namespace, which is what lets a test say "this tenant is still running" or "this tenant is off". */
export function smokeWith(desired: number) {
  return {
    namespaceExists: true,
    workloads: [{ kind: "Deployment", name: "example-auth-backend", available: true, desired, ready: desired }],
    externalSecretsReady: true,
  };
}

/** A cluster reader whose deploy-state attests and whose smoke reports the given replica count. */
export function readerRunning(desired: number): FakeClusterReader {
  return new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 }, smoke: smokeWith(desired) });
}

/** The helpers that write to or read from the test's database, bound to it once per test file:
 *  `const { ctx, seedTenant, runAll } = lifecycleHarness(() => db);`. */
export function lifecycleHarness(getDb: () => DbHandle) {
  function ctx(runId: string, stepName: string, params: Record<string, unknown>, logs: string[]): StepCtx {
    return {
      runId, stepName, db: getDb().db, creds: {} as unknown as CredentialStore, params,
      secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
      ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
      closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
      log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
    };
  }
  // `appStatus` is separate from `status` on purpose: a tenant_apps row carries its OWN lifecycle state,
  // and the watch-set filter is keyed on it — so a test has to be able to set the two independently.
  function seedTenant(opts: { status?: TenantStatus; appStatus?: TenantStatus; suspended?: boolean; apps?: string[] } = {}): void {
    getDb().db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    getDb().db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    getDb().db.insert(tenants).values({
      id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "example", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "", displayName: "",
      suspended: opts.suspended ?? false, status: opts.status ?? "active",
    }).run();
    for (const name of opts.apps ?? ["erp"]) getDb().db.insert(tenantApps).values({ id: `tna_${name}`, tenantId: "tnt_1", name, status: opts.appStatus ?? "active" }).run();
  }
  async function runAll(steps: Step[], runId: string, params: Record<string, unknown>, logs: string[]): Promise<void> {
    for (const step of steps) await step.run(ctx(runId, step.name, params, logs));
  }
  return { ctx, seedTenant, runAll };
}
