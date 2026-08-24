import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { makeRestartWorkloadsDef, makeTenantRestartWorkloadsDef } from "./restart-workloads.run.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { memberNamespace } from "./tenant-fanout.ts";
import type { LifecyclePorts, TenantLifecyclePorts } from "./lifecycle.ts";
import type { Step, StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";

// restart-workloads / tenant-restart-workloads — the last step of putting a new secret value in front
// of a unit. What is asserted is exactly what the run kind promises and nothing more: the PATCH reached
// the right namespace(s) under ONE stamp, no registration was written, and a cluster that refuses the
// patch fails the run instead of reporting a delivery that only ever got as far as the Secret.

const GUID = "zsjs023ctne0";

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

function ctx(runId: string, stepName: string, params: Record<string, unknown>, logs: string[]): StepCtx {
  return {
    runId, stepName, db: db.db, creds: {} as unknown as CredentialStore, params,
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

async function runAll(steps: Step[], runId: string, params: Record<string, unknown>, logs: string[]): Promise<void> {
  for (const step of steps) await step.run(ctx(runId, step.name, params, logs));
}

const ATTESTING = { deployState: { domain: "s1.example", stage: "prod" as const, writtenAt: "x", generation: 1 } };

function consumerPorts(reg: Registrations, cluster: FakeClusterReader): LifecyclePorts {
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster,
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000,
  };
}

function tenantPorts(reg: TenantRegistrations, cluster: FakeClusterReader): TenantLifecyclePorts {
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster,
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    catalogRepoUrl: "https://github.com/simetrixch/catalog.git",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    dns: new FakeDnsProvider(),
  };
}

function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

function seedApp(): void {
  seedCluster();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "controller", status: "active" }).run();
}

function seedTenant(): void {
  seedCluster();
  db.db.insert(tenants).values({
    id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "simetrix.dev", stage: "prod",
    members: ["auth", "jobs", "report"], identityProvider: "auth", suspended: false, status: "active",
  }).run();
  db.db.insert(tenantApps).values({ id: "tna_erp", tenantId: "tnt_1", name: "erp", status: "active" }).run();
}

describe("restart-workloads run (consumer)", () => {
  it("patches the consumer's OWN namespace and nothing else", async () => {
    seedApp();
    // The namespace IS the consumer name (G1) — the assertion that the run derived it from the row
    // rather than from anything the caller passed.
    const cluster = new FakeClusterReader({ ...ATTESTING, workloadsPerNamespace: { acme: 3 } });
    const logs: string[] = [];
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await runAll(makeRestartWorkloadsDef(consumerPorts(reg, cluster)).steps({ appId: "app_1" }), "run_r", { appId: "app_1" }, logs);

    expect(cluster.restarted.map((r) => r.namespace)).toEqual(["acme"]);
    expect(logs.join("\n")).toContain("3 workload(s) of acme rolled");
  });

  it("stamps the pod template with an instant — what makes the template DIFFERENT, which is what rolls it", async () => {
    seedApp();
    const cluster = new FakeClusterReader({ ...ATTESTING, workloadsPerNamespace: { acme: 1 } });
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await runAll(makeRestartWorkloadsDef(consumerPorts(reg, cluster)).steps({ appId: "app_1" }), "run_r", { appId: "app_1" }, []);

    expect(cluster.restarted[0]?.stampedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports a unit with no workload as such instead of as a delivery that landed", async () => {
    seedApp();
    // A suspended consumer renders replicas 0 — nothing to roll, and no pod holding a stale value.
    const cluster = new FakeClusterReader({ ...ATTESTING, workloadsPerNamespace: { acme: 0 } });
    const logs: string[] = [];
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await runAll(makeRestartWorkloadsDef(consumerPorts(reg, cluster)).steps({ appId: "app_1" }), "run_r", { appId: "app_1" }, logs);

    expect(logs.join("\n")).toContain("no workload on s1.example to roll");
  });

  it("FAILS the run when the cluster refuses the patch — never reports a half-done delivery", async () => {
    seedApp();
    const cluster = new FakeClusterReader({ ...ATTESTING, throwOnRestart: new Error("deployments.apps is forbidden: patch") });
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    const steps = makeRestartWorkloadsDef(consumerPorts(reg, cluster)).steps({ appId: "app_1" });
    await expect(runAll(steps, "run_r", { appId: "app_1" }, [])).rejects.toThrow(/forbidden: patch/);
  });

  it("plans attest-target first, claims no BOOKS branch, and says in the summary that it moves no secret", async () => {
    seedApp();
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    const plan = await makeRestartWorkloadsDef(consumerPorts(reg, new FakeClusterReader(ATTESTING))).plan({ appId: "app_1" }, { db: db.db });

    expect(plan.targetKind).toBe("app");
    // mutating ⇒ attest-target is step 0: a run approved against a cluster that has since changed
    // identity refuses BEFORE it patches.
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "restart-workloads"]);
    // NO git-branch claim at all, unlike every other consumer run kind: this run neither reads nor writes
    // git, so a branch lock would block the flip run kinds and serialize nothing. master-kube is what keeps
    // a teardown of the same unit from running beside it — every teardown claims it.
    expect(plan.locks).toEqual([{ resource: "master-kube", key: "m" }]);
    expect(plan.summary).toContain("MOVES NO SECRET");
  });
});

describe("tenant-restart-workloads run", () => {
  it("walks EVERY member namespace of the tenant under ONE stamp", async () => {
    seedTenant();
    const expected = ["auth", "jobs", "report", "erp"].map((m) => memberNamespace(GUID, m));
    const cluster = new FakeClusterReader({ ...ATTESTING, workloadsPerNamespace: Object.fromEntries(expected.map((ns) => [ns, 2])) });
    const logs: string[] = [];
    const reg = new TenantRegistrations(new FakePlatformRepo(), async (c) => ({ name: c, stage: "prod" }));
    await runAll(makeTenantRestartWorkloadsDef(tenantPorts(reg, cluster)).steps({ tenantId: "tnt_1" }), "run_tr", { tenantId: "tnt_1" }, logs);

    // A tenant owns one namespace PER MEMBER — rolling only one of them would leave the other members
    // on the old value, which is the whole reason the tenant run kind is not the consumer run kind.
    expect(cluster.restarted.map((r) => r.namespace).sort()).toEqual([...expected].sort());
    // ONE stamp for the whole tenant, so the member namespaces read afterwards as one act.
    expect(new Set(cluster.restarted.map((r) => r.stampedAt)).size).toBe(1);
    expect(logs.join("\n")).toContain(`8 workload(s) across 4 member namespace(s) of ${GUID} rolled`);
  });

  it("plans attest-target first, names the member namespaces, and claims no catalog books lock", async () => {
    seedTenant();
    const reg = new TenantRegistrations(new FakePlatformRepo(), async (c) => ({ name: c, stage: "prod" }));
    const plan = await makeTenantRestartWorkloadsDef(tenantPorts(reg, new FakeClusterReader(ATTESTING))).plan({ tenantId: "tnt_1" }, { db: db.db });

    expect(plan.targetKind).toBe("tenant");
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "restart-workloads"]);
    // The operator approves a namespace LIST, not a count: the members are what can be checked against
    // the Vault entry whose value was just replaced.
    expect(plan.summary).toContain(memberNamespace(GUID, "erp"));
    // Every OTHER tenant run kind claims `catalog@<books>` plus the cluster branch because it writes
    // the registration; this one writes nothing, so it queues behind none of them.
    expect(plan.locks).toEqual([{ resource: "master-kube", key: "m" }]);
  });
});
