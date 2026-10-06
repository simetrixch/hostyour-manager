import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeSuspendDef, makeResumeDef } from "./suspend-resume.run.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { LifecyclePorts } from "./lifecycle.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ArgoAppStatus, SmokeResult, WorkloadStatus } from "../../adapters/kube/port.ts";

const SHA = "a".repeat(40);

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });


/** Commit acme's STAGE registration on s1.example/prod, `suspended` at the given state — what
 *  suspend/resume flips a field on, not a file it moves between directories. */
async function seedRegistration(reg: Registrations, over: { suspended?: boolean } = {}): Promise<void> {
  await reg.commitRegistration({
    unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: over.suspended ?? false, quiesced: false },
    builds: [],
    deploy: { stage: "prod", host: "acme", chartPath: "deploy/chart", cluster: "s1", databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
    runId: "run_onb",
  });
}

// The kube clients ride behind the resolver now: the master path resolves to the scripted
// argo (built from `status`) + a cluster reader + argoNamespace "argocd", behavior-identical to before.
function ports(reg: Registrations, status: ArgoAppStatus, workloads: WorkloadStatus[] = []): LifecyclePorts & { argo: FakeMasterArgoReader } {
  const argo = new FakeMasterArgoReader({ status });
  const smoke: SmokeResult = { namespaceExists: true, workloads, externalSecretsReady: true };
  return {
    argo,
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 }, smoke }),
      argoReader: argo,
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000,
  };
}

/** The generated Application as ArgoCD reports it, rendering the chart with `suspended` at `value`. */
const rendering = (value: boolean | undefined, over: Partial<ArgoAppStatus> = {}): ArgoAppStatus => ({
  syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy",
  syncSources: [{ repoURL: "https://github.com/x/acme.git", revision: SHA, path: "deploy/chart", ...(value !== undefined ? { valuesObject: { suspended: value } } : {}) }],
  ...over,
});
const serving: WorkloadStatus = { kind: "Deployment", name: "acme", available: true, desired: 1, ready: 1 };
const off: WorkloadStatus = { kind: "Deployment", name: "acme", available: true, desired: 0, ready: 0 };

function ctx(runId: string, stepName: string, logs: string[]): StepCtx {
  return {
    runId, stepName, db: db.db, creds: {} as unknown as CredentialStore, params: { appId: "app_1" },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function seedApp(status: "active" | "suspended"): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", host: "acme", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "manager", status }).run();
}

describe("suspend run", () => {
  it("flips the registration to suspended, waits for the off render to converge, and marks the row suspended", async () => {
    seedApp("active");
    const reg = new Registrations(new FakePlatformRepo());
    await seedRegistration(reg);

    // suspend does NOT prune — it is a field flip, and the render still converges Synced/Healthy
    // (0 replicas, no Ingress) rather than going Missing.
    const logs: string[] = [];
    for (const step of makeSuspendDef(ports(reg, rendering(true), [off])).steps({ appId: "app_1" })) {
      await step.run(ctx("run_susp", step.name, logs));
    }
    expect((await reg.readRegistration("prod", "acme"))?.entry.suspended).toBe(true);
    expect(db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status).toBe("suspended");
  });

  it("plans with app targetKind and the git-branch/master-kube locks", async () => {
    seedApp("active");
    const reg = new Registrations(new FakePlatformRepo());
    const plan = await makeSuspendDef(ports(reg, { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" })).plan({ appId: "app_1" }, { db: db.db });
    expect(plan.targetKind).toBe("app");
    // The row moves BEFORE the commit: from the flip onward the inventory and the registration
    // state the same thing, where moving the row last leaves minutes in which they disagree.
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "record-suspended", "suspend-registration", "watch-converged"]);
    // The BOOKS branch first, exactly as onboard/offboard/purge/backup/restore/migrate claim it: the
    // suspended flip commits there, and a lock keyed only on the consumer's cluster would let a
    // concurrent registration write hard-reset the shared books worktree underneath it.
    expect(plan.locks).toEqual([
      { resource: "git-branch", key: reg.branch },
      { resource: "git-branch", key: "s1.example" },
      { resource: "master-kube", key: "m" },
    ]);
  });
});

describe("resume run", () => {
  it("flips the registration back to running, waits for Synced/Healthy at the pin, and marks the row active", async () => {
    seedApp("suspended");
    const reg = new Registrations(new FakePlatformRepo());
    await seedRegistration(reg, { suspended: true }); // start suspended

    const logs: string[] = [];
    for (const step of makeResumeDef(ports(reg, rendering(false), [serving])).steps({ appId: "app_1" })) {
      await step.run(ctx("run_res", step.name, logs));
    }
    expect((await reg.readRegistration("prod", "acme"))?.entry.suspended).toBe(false);
    expect(db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status).toBe("active");
    expect(logs.some((l) => l.includes("the consumer is running"))).toBe(true);
  });

  it("resume fails when ArgoCD never re-converges on the running render", async () => {
    seedApp("suspended");
    const reg = new Registrations(new FakePlatformRepo());
    await seedRegistration(reg, { suspended: true });
    await expect(watchAfterFlip(makeResumeDef, ports(reg, rendering(false, { sync: "OutOfSync", health: "Progressing" }), [serving]))).rejects.toThrow(/did not reach Synced/);
  });
});

/** Run the flip steps of `def`, then answer what the watch step does. */
async function watchAfterFlip(def: typeof makeResumeDef, p: LifecyclePorts): Promise<void> {
  const steps = def(p).steps({ appId: "app_1" });
  for (const step of steps.slice(0, -1)) await step.run(ctx("run_x", step.name, []));
  await steps.at(-1)!.run(ctx("run_x", "watch-converged", []));
}

describe("the watch waits for the render the flip asked for", () => {
  it("PLANTED: a resume does not pass while the Application still renders suspended", async () => {
    seedApp("suspended");
    const reg = new Registrations(new FakePlatformRepo());
    await seedRegistration(reg, { suspended: true });
    await expect(watchAfterFlip(makeResumeDef, ports(reg, rendering(true), [serving]))).rejects.toThrow(/running render — last seen suspended=true/);
  });

  it("PLANTED: a suspend does not pass while the Application still renders running", async () => {
    seedApp("active");
    const reg = new Registrations(new FakePlatformRepo());
    await seedRegistration(reg);
    await expect(watchAfterFlip(makeSuspendDef, ports(reg, rendering(false), [off]))).rejects.toThrow(/suspended render — last seen suspended=false/);
  });

  it("PLANTED: a resume does not pass while no workload asks for replicas", async () => {
    seedApp("suspended");
    const reg = new Registrations(new FakePlatformRepo());
    await seedRegistration(reg, { suspended: true });
    await expect(watchAfterFlip(makeResumeDef, ports(reg, rendering(false), [off]))).rejects.toThrow(/no workload in acme-prod asks for replicas/);
  });

  it("PLANTED: a suspend does not pass while a workload still asks for replicas", async () => {
    seedApp("active");
    const reg = new Registrations(new FakePlatformRepo());
    await seedRegistration(reg);
    await expect(watchAfterFlip(makeSuspendDef, ports(reg, rendering(true), [serving]))).rejects.toThrow(/acme-prod still runs Deployment\/acme \(1\/1\)/);
  });

  it("PLANTED: a resume does not pass while a workload that asks for replicas is not available", async () => {
    seedApp("suspended");
    const reg = new Registrations(new FakePlatformRepo());
    await seedRegistration(reg, { suspended: true });
    await expect(watchAfterFlip(makeResumeDef, ports(reg, rendering(false), [{ ...serving, available: false, ready: 0 }])))
      .rejects.toThrow(/Deployment\/acme \(0\/1\) in acme-prod is not available/);
  });

  it("PLANTED: the watch refuses when the registration no longer asks for the render it waits for", async () => {
    seedApp("suspended");
    const reg = new Registrations(new FakePlatformRepo());
    await seedRegistration(reg, { suspended: true });
    const steps = makeResumeDef(ports(reg, rendering(true), [off])).steps({ appId: "app_1" });
    await expect(steps.at(-1)!.run(ctx("run_x", "watch-converged", []))).rejects.toThrow(/registration no longer requests the running render/);
  });

  it("refreshes the ApplicationSet and the Application before it watches", async () => {
    seedApp("suspended");
    const reg = new Registrations(new FakePlatformRepo());
    await seedRegistration(reg, { suspended: true });
    const p = ports(reg, rendering(false), [serving]);
    await watchAfterFlip(makeResumeDef, p);
    expect(p.argo.operations).toEqual(["refresh-set:argocd/consumer-apps", "refresh:argocd/acme-prod", "watch:argocd/acme-prod"]);
  });
});

describe("a consumer with its own store", () => {
  // The per-consumer PostgreSQL and its exporter stand in the consumer's namespace as another source of
  // the same Application, and read neither switch: they keep running through a suspend.
  const postgres: WorkloadStatus = { kind: "Deployment", name: "postgres", available: true, desired: 1, ready: 1 };
  const exporter: WorkloadStatus = { kind: "Deployment", name: "acme-prod-prometheus-postgres-exporter", available: true, desired: 1, ready: 1 };
  async function seedWithPostgres(reg: Registrations, suspended: boolean): Promise<void> {
    await reg.commitRegistration({
      unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended, quiesced: false },
      builds: [],
      deploy: { stage: "prod", host: "acme", chartPath: "deploy/chart", cluster: "s1", databases: [], keyPatterns: [], channelPatterns: [], services: ["postgresql"], size: "small", mongodb: "shared", quota: seedQuota("small") },
      runId: "run_onb",
    });
  }

  it("a suspend passes while only the consumer's own store still asks for replicas", async () => {
    seedApp("active");
    const reg = new Registrations(new FakePlatformRepo());
    await seedWithPostgres(reg, false);
    await expect(watchAfterFlip(makeSuspendDef, ports(reg, rendering(true), [off, postgres, exporter]))).resolves.toBeUndefined();
  });

  it("a suspend passes while only the consumer's own Redis still asks for replicas", async () => {
    seedApp("active");
    const reg = new Registrations(new FakePlatformRepo());
    await reg.commitRegistration({
      unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false },
      builds: [],
      deploy: { stage: "prod", host: "acme", chartPath: "deploy/chart", cluster: "s1", databases: [], keyPatterns: [], channelPatterns: [], services: ["redis"], size: "small", mongodb: "shared", redis: "standalone", redisMaxmemoryPolicy: "noeviction", quota: seedQuota("small") },
      runId: "run_onb",
    });
    const redis: WorkloadStatus = { kind: "Deployment", name: "redis", available: true, desired: 1, ready: 1 };
    await expect(watchAfterFlip(makeSuspendDef, ports(reg, rendering(true), [off, redis, { ...redis, name: "redis-exporter" }]))).resolves.toBeUndefined();
  });

  it("PLANTED: a resume does not pass while only the consumer's own store asks for replicas", async () => {
    seedApp("suspended");
    const reg = new Registrations(new FakePlatformRepo());
    await seedWithPostgres(reg, true);
    await expect(watchAfterFlip(makeResumeDef, ports(reg, rendering(false), [off, postgres, exporter]))).rejects.toThrow(/no workload in acme-prod asks for replicas/);
  });
});
