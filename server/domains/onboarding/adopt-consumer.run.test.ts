import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq, and } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeAdoptConsumerDef, type AdoptConsumerPorts, type AdoptConsumerParams } from "./adopt-consumer.run.ts";
import { Registry, serializePointer, type ClusterStageResolver } from "./registry.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver } from "../../adapters/kube/testing/fake.ts";
import { ConsumerRegistrationSchema } from "../../../shared/consumer.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";

// adopt-consumer tests — mirrors purge.run.test.ts conventions (the same fake
// kube/git clients, the same in-memory DB): the twin recovery verb, NAME-keyed with no appId. The
// load-bearing properties: attest-target FIRST and fail-closed, read-pointer refuses an
// already-tracked consumer and a missing/mixed-identity registration, attest-live is SOFT (a missing app
// or an unreadable cluster never blocks the adoption — it is RECORDED, not gated), and record-inventory
// writes the row THROUGH the shared upsert with provenance "adopted", version null (the registration
// states no revision — the consumer's pin is the consumer's own), and the registration's fields —
// repoCredentialId above all — copied VERBATIM, never re-sealed.

const PARAMS: AdoptConsumerParams = { consumerName: "acme", stage: "prod", clusterId: "cls_1" };

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

// Every fixture runs on the prod stage, so a fixed resolver answers every cluster with "prod" — the
// stage boundary Registry.commitRegistration checks before it ever writes a stage file.
const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader };

function ports(reg: Registry, over: FakeKube = {}): AdoptConsumerPorts {
  return {
    registry: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: over.cluster ?? new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
      // Default: the Application does not exist (getApplication → null) — attest-live must record
      // that and CONTINUE (the registration is the record of intent).
      argoReader: over.argo ?? new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000,
  };
}

function ctx(stepName: string, logs: string[]): StepCtx {
  return {
    runId: "run_adopt", stepName, db: db.db, creds: {} as unknown as CredentialStore, params: { ...PARAMS },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

/** The cluster only — NO app row. The DETECTED precondition: an onboard that died before
 *  record-inventory (or a hand-written registration) left GitOps state but no inventory row. */
function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

/** A registry whose fake platform repo carries acme's live STAGE registration on s1.example/prod. */
async function deployedRegistry(over: { repoCredentialId?: string; suspended?: boolean } = {}): Promise<Registry> {
  const reg = new Registry(new FakePlatformRepo(), prodClusterStage);
  await reg.commitRegistration({
    unit: {
      name: "acme", repoURL: "https://github.com/x/acme.git",
      suspended: over.suspended ?? false, quiesced: false,
      ...(over.repoCredentialId ? { repoCredentialId: over.repoCredentialId } : {}),
    },
    builds: [],
    deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
    runId: "run_onb",
  });
  return reg;
}

async function runAll(prt: AdoptConsumerPorts, logs: string[]): Promise<void> {
  for (const step of makeAdoptConsumerDef(prt).steps(PARAMS)) await step.run(ctx(step.name, logs));
}

const STEP_ORDER = ["attest-target", "read-pointer", "attest-live", "record-inventory"];

describe("adopt-consumer run definition", () => {
  it("plans with cluster targetKind, the ordered steps, and the git-branch lock — with NO app row", async () => {
    seedCluster();
    const adoptRegistry = new Registry(new FakePlatformRepo(), prodClusterStage);
    const def = makeAdoptConsumerDef(ports(adoptRegistry));
    const plan = await def.plan(PARAMS, { db: db.db });
    expect(def.mutating).toBe(true);
    // No app row exists (that is the point), so adopt targets the CLUSTER — like onboard's and purge's plan.
    expect(plan.targetKind).toBe("cluster");
    expect(plan.targetId).toBe("cls_1");
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_ORDER);
    // Git-branch locks only — nothing on any cluster is written. The BOOKS branch is the one that
    // matters: the registration read rides that worktree, which every registration writer hard-resets.
    expect(plan.locks).toEqual([
      { resource: "git-branch", key: adoptRegistry.branch },
      { resource: "git-branch", key: "s1.example" },
    ]);
    expect(plan.requiredSecrets).toEqual([]);
    expect(plan.summary).toContain('provenance "adopted"'); // the plan states the honesty marker plainly
    expect(plan.summary).toContain("NOTHING is deployed");
  });

  it("mutating def starts with attest-target under empty params (the armed check does def.steps({}))", () => {
    expect(makeAdoptConsumerDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage))).steps({} as AdoptConsumerParams)[0]?.name).toBe("attest-target");
  });

  it("attest-target fails closed on a deploy-state domain mismatch (never record against the wrong cluster)", async () => {
    seedCluster();
    const prt = ports(new Registry(new FakePlatformRepo(), prodClusterStage), { cluster: new FakeClusterReader({ deployState: { domain: "other.example", stage: "prod", writtenAt: "x", generation: 1 } }) });
    const attest = makeAdoptConsumerDef(prt).steps(PARAMS)[0]!;
    await expect(attest.run(ctx("attest-target", []))).rejects.toThrow(/deploy-state mismatch/);
  });

  it("plan fails closed on a stage that disagrees with the target cluster's own stage", async () => {
    seedCluster(); // cls_1 is prod
    const def = makeAdoptConsumerDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage)));
    await expect(def.plan({ consumerName: "acme", stage: "dev", clusterId: "cls_1" }, { db: db.db })).rejects.toThrow(/stage mismatch/);
  });

  it("plan refuses when an UNSETTLED row already tracks the consumer — nothing invisible to adopt", async () => {
    seedCluster();
    db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", provenance: "controller", status: "active" }).run();
    const def = makeAdoptConsumerDef(ports(await deployedRegistry()));
    await expect(def.plan(PARAMS, { db: db.db })).rejects.toThrow(/already tracked/);
  });

  it("read-pointer refuses when a row appeared since planning — one rule, asked at both ends", async () => {
    // approve re-validates nothing, so the run re-asks the plan-time refusal itself: a finishing
    // onboard (or a second adopt) that recorded the row in between must not be overwritten.
    seedCluster();
    db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", provenance: "controller", status: "suspended" }).run();
    const step = makeAdoptConsumerDef(ports(await deployedRegistry())).steps(PARAMS).find((s) => s.name === "read-pointer")!;
    await expect(step.run(ctx("read-pointer", []))).rejects.toThrow(/already tracked/);
  });

  it("read-pointer fails NOT_FOUND when no registration exists — there is nothing to adopt", async () => {
    seedCluster();
    const step = makeAdoptConsumerDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage))).steps(PARAMS).find((s) => s.name === "read-pointer")!;
    await expect(step.run(ctx("read-pointer", []))).rejects.toThrow(/does not exist, so there is nothing to adopt/);
  });

  it("read-pointer refuses a registration whose BODY name disagrees with its directory — never adopt a mixed identity", async () => {
    seedCluster();
    const repo = new FakePlatformRepo();
    // Registrations live on `master` (REGISTRATION_BRANCH), never on the domain's own install branch.
    repo.seed(repo.booksBranch, "registrations/acme/prod.yaml", serializePointer(ConsumerRegistrationSchema, {
      name: "other", repoURL: "https://github.com/x/other.git", suspended: false, quiesced: false,
      chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small"),
    }));
    const step = makeAdoptConsumerDef(ports(new Registry(repo, prodClusterStage))).steps(PARAMS).find((s) => s.name === "read-pointer")!;
    await expect(step.run(ctx("read-pointer", []))).rejects.toThrow(/disagrees with its directory name/);
  });

  it("FULL RUN over a live, non-suspended registration: writes the row with provenance adopted, verbatim fields, status active", async () => {
    seedCluster(); // NO app row — the detected precondition
    const logs: string[] = [];
    await runAll(ports(await deployedRegistry()), logs);

    const row = db.db.select().from(apps).where(and(eq(apps.clusterId, "cls_1"), eq(apps.name, "acme"))).get();
    expect(row).toMatchObject({
      clusterId: "cls_1",
      name: "acme",
      stage: "prod",
      repoUrl: "https://github.com/x/acme.git",
      chartPath: "deploy/chart",
      repoCredentialId: null, // the registration carried none — nothing invented, nothing re-sealed
      provenance: "adopted", // reconstructed from the registration — NEVER "controller" (gate-validated)
      status: "active",
      lastRunId: "run_adopt",
    });
    // The honesty trail: the registration's claim AND the live truth were logged before the row was written.
    expect(logs.some((l) => l.includes("This is what the REGISTRATION says"))).toBe(true);
    expect(logs.some((l) => l.includes("live cluster: namespace acme"))).toBe(true);
    expect(logs.some((l) => l.includes("provenance adopted"))).toBe(true);
  });

  it("copies repoCredentialId VERBATIM when the registration carries one — the sealed id, never re-sealed", async () => {
    seedCluster();
    const logs: string[] = [];
    await runAll(ports(await deployedRegistry({ repoCredentialId: "cred_ptr" })), logs);
    const row = db.db.select().from(apps).where(and(eq(apps.clusterId, "cls_1"), eq(apps.name, "acme"))).get();
    expect(row?.repoCredentialId).toBe("cred_ptr");
  });

  it("a registration with suspended:true is adopted with status SUSPENDED — the row repeats the record of intent", async () => {
    // Recording it "active" would put the wrong lifecycle verb on its card — a suspended unit is
    // resumed, not suspended again.
    seedCluster();
    await runAll(ports(await deployedRegistry({ suspended: true })), []);
    const row = db.db.select().from(apps).where(and(eq(apps.clusterId, "cls_1"), eq(apps.name, "acme"))).get();
    expect(row).toMatchObject({ status: "suspended", provenance: "adopted" });
  });

  it("attest-live is SOFT on a MISSING Application: records the absence and continues", async () => {
    seedCluster();
    const argo = new FakeMasterArgoReader(); // getApplication → null
    const step = makeAdoptConsumerDef(ports(await deployedRegistry(), { argo })).steps(PARAMS).find((s) => s.name === "attest-live")!;
    const logs: string[] = [];
    await expect(step.run(ctx("attest-live", logs))).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("Application acme-prod does not exist"))).toBe(true);
  });

  it("attest-live is SOFT on an UNREADABLE ArgoCD: records 'unknown', never a hard fail", async () => {
    seedCluster();
    const argo = new FakeMasterArgoReader({ throwOnGet: new Error("argocd unreachable") });
    const step = makeAdoptConsumerDef(ports(await deployedRegistry(), { argo })).steps(PARAMS).find((s) => s.name === "attest-live")!;
    const logs: string[] = [];
    await expect(step.run(ctx("attest-live", logs))).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("ArgoCD could not be read") && l.includes("argocd unreachable"))).toBe(true);
  });

  it("attest-live watches the GENERATED Application name (<name>-<stage>), never the bare name", async () => {
    seedCluster();
    const argo = new FakeMasterArgoReader({ status: { syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy" } });
    const gets: string[] = [];
    const orig = argo.getApplication.bind(argo);
    // The fake's getApplication ignores its (namespace, name) args — record them here so the test can
    // pin WHICH Application the step asked for (the generated <name>-<stage>, never the bare name).
    argo.getApplication = (async (...args: unknown[]) => { gets.push(args.join("/")); return orig(); }) as typeof argo.getApplication;
    const step = makeAdoptConsumerDef(ports(await deployedRegistry(), { argo })).steps(PARAMS).find((s) => s.name === "attest-live")!;
    await step.run(ctx("attest-live", []));
    expect(gets).toEqual(["argocd/acme-prod"]);
  });

  it("record-inventory is overwrite-idempotent — a resumed re-run leaves exactly ONE row", async () => {
    seedCluster();
    const prt = ports(await deployedRegistry());
    const step = makeAdoptConsumerDef(prt).steps(PARAMS).find((s) => s.name === "record-inventory")!;
    await step.run(ctx("record-inventory", []));
    await step.run(ctx("record-inventory", [])); // the crash-resumed executor re-runs the local step
    expect(db.db.select().from(apps).all()).toHaveLength(1);
  });

  it("adopting over a SETTLED (offboarded) row reuses THAT row — flipped back to a live status, provenance adopted", async () => {
    // A settled row records a removal that already ran; a registration standing again means the
    // consumer is back. The (clusterId, name, stage) upsert finds the old row instead of duplicating.
    seedCluster();
    db.db.insert(apps).values({ id: "app_old", clusterId: "cls_1", name: "acme", stage: "prod", provenance: "controller", status: "offboarded" }).run();
    await runAll(ports(await deployedRegistry()), []);
    const all = db.db.select().from(apps).all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: "app_old", status: "active", provenance: "adopted", lastRunId: "run_adopt" });
  });

  it("a SECOND adopt refuses — the first one made the consumer tracked, so there is nothing to adopt", async () => {
    seedCluster();
    const prt = ports(await deployedRegistry());
    await runAll(prt, []);
    await expect(runAll(prt, [])).rejects.toThrow(/already tracked/);
  });
});
