import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeSuspendDef, makeResumeDef } from "./suspend-resume.run.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import type { LifecyclePorts } from "./lifecycle.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";

const SHA = "a".repeat(40);

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

// Every fixture runs on the prod stage, so a fixed resolver answers every cluster with "prod" — the
// stage boundary Registrations.commitRegistration checks before it ever writes a stage file.
const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

/** Commit acme's STAGE registration on s1.example/prod, `suspended` at the given state — what
 *  suspend/resume flips a field on, not a file it moves between directories. */
async function seedRegistration(reg: Registrations, over: { suspended?: boolean } = {}): Promise<void> {
  await reg.commitRegistration({
    unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: over.suspended ?? false, quiesced: false },
    builds: [],
    deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
    runId: "run_onb",
  });
}

// The kube clients ride behind the resolver now: the master path resolves to the scripted
// argo (built from `status`) + a cluster reader + argoNamespace "argocd", behavior-identical to before.
function ports(reg: Registrations, status: ArgoAppStatus): LifecyclePorts {
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } }),
      argoReader: new FakeMasterArgoReader({ status }),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000,
  };
}

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
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "manager", status }).run();
}

describe("suspend run", () => {
  it("flips the registration to suspended, waits for the off render to converge, and marks the row suspended", async () => {
    seedApp("active");
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(reg);

    // suspend does NOT prune — it is a field flip, and the render still converges Synced/Healthy
    // (0 replicas, no Ingress) rather than going Missing.
    const logs: string[] = [];
    for (const step of makeSuspendDef(ports(reg, { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" })).steps({ appId: "app_1" })) {
      await step.run(ctx("run_susp", step.name, logs));
    }
    expect((await reg.readRegistration("prod", "acme"))?.entry.suspended).toBe(true);
    expect(db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status).toBe("suspended");
  });

  it("plans with app targetKind and the git-branch/master-kube locks", async () => {
    seedApp("active");
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
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
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(reg, { suspended: true }); // start suspended

    const logs: string[] = [];
    for (const step of makeResumeDef(ports(reg, { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" })).steps({ appId: "app_1" })) {
      await step.run(ctx("run_res", step.name, logs));
    }
    expect((await reg.readRegistration("prod", "acme"))?.entry.suspended).toBe(false);
    expect(db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status).toBe("active");
    expect(logs.some((l) => l.includes("the consumer is running"))).toBe(true);
  });

  it("resume fails when ArgoCD never re-converges on the running render", async () => {
    seedApp("suspended");
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(reg, { suspended: true });
    const steps = makeResumeDef(ports(reg, { syncRevision: SHA, targetRevision: null, sync: "OutOfSync", health: "Progressing" })).steps({ appId: "app_1" });
    await steps[0]!.run(ctx("run_res", "attest-target", []));
    await steps[1]!.run(ctx("run_res", "resume-registration", []));
    await expect(steps[3]!.run(ctx("run_res", "watch-converged", []))).rejects.toThrow(/did not reach Synced/);
  });
});
