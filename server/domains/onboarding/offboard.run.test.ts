import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makeOffboardDef, type OffboardPorts } from "./offboard.run.ts";
import { renderConsumerAppProject } from "./appproject.ts";
import { renderBuildRbac } from "./build-rbac.ts";
import { Registry, type ClusterStageResolver } from "./registry.ts";
import { BUILD_HOOK_URL } from "./cluster-map.fixture.ts";
import { FakePlatformRepo, FakeConsumerRepo, FAKE_BOOKS_BRANCH } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { AppError } from "../../kernel/errors.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultSeeder, VaultSeedOutcome, BuildRepoPatDeleteInput, AppSecretsDeleteInput, PostgresSecretDeleteInput, MongodbSecretDeleteInput } from "./vault-seeder.ts";

const SHA = "a".repeat(40);

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

// Every fixture offboards from the prod stage, so a fixed resolver answers every cluster with "prod" —
// the stage boundary Registry.commitRegistration checks before it ever writes a stage file.
const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });


/** Commit acme's live STAGE registration on s1.example/prod — the offboard target every test
 *  that needs a real registration to remove starts from. */
async function seedRegistration(reg: Registry): Promise<void> {
  await reg.commitRegistration({
    unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false },
    builds: [],
    deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
    runId: "run_onb",
  });
}

// The kube clients ride behind the resolver now: fold the per-test fakes (argo/cluster/
// projects) into a FakeClusterKubeResolver whose master path resolves to argoNamespace "argocd".
type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

// remove-repo-pat and remove-app-secrets drive the seeder's two deletes — a recording no-op fake by default.
class FakeSeeder implements VaultSeeder {
  deleted: BuildRepoPatDeleteInput[] = [];
  deletedApp: AppSecretsDeleteInput[] = [];
  deletedPostgres: PostgresSecretDeleteInput[] = [];
  deletedMongodb: MongodbSecretDeleteInput[] = [];
  async seed(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds"); }
  async seedPostgres(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds postgres"); }
  async seedMongodb(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds mongodb"); }
  async seedBuildRepoPat(): Promise<VaultSeedOutcome> { throw new Error("offboard never seeds a repo pat"); }
  async deleteBuildRepoPat(i: BuildRepoPatDeleteInput): Promise<void> { this.deleted.push(i); }
  async deleteApp(i: AppSecretsDeleteInput): Promise<void> { this.deletedApp.push(i); }
  async deletePostgres(i: PostgresSecretDeleteInput): Promise<void> { this.deletedPostgres.push(i); }
  async deleteMongodb(i: MongodbSecretDeleteInput): Promise<void> { this.deletedMongodb.push(i); }
  async seedTenantCrypto(): Promise<VaultSeedOutcome> { return { created: true }; }
  async deleteTenantCrypto(): Promise<void> {}
}

/** A VaultSeeder whose four deletes are all no-ops, with ONE of them overridden per test. Every seed
 *  method answers `created: true` and is never reached — an offboard removes, it never seeds. Written
 *  once because the four failure tests below differ in exactly one method, and five hand-rolled copies
 *  of the same seven members is what obscured that. */
function seederWith(over: Partial<VaultSeeder>): VaultSeeder {
  return {
    seed: async () => ({ created: true }),
    seedPostgres: async () => ({ created: true }), seedMongodb: async () => ({ created: true }),
    seedBuildRepoPat: async () => ({ created: true }),
    seedTenantCrypto: async () => ({ created: true }),
    deleteBuildRepoPat: async () => {},
    deleteApp: async () => {},
    deletePostgres: async () => {}, deleteMongodb: async () => {},
    deleteTenantCrypto: async () => {},
    ...over,
  };
}

function ports(reg: Registry, over: Partial<OffboardPorts> & FakeKube = {}): OffboardPorts {
  const { argo, cluster, projects, ...portOver } = over;
  return {
    registry: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
      argoReader: argo ?? new FakeMasterArgoReader({ status: { syncRevision: null, targetRevision: null, sync: "Unknown", health: "Missing" } }),
      projectWriter: projects ?? new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000, seeder: new FakeSeeder(), dns: new FakeDnsProvider(),
    // The offboard target s1.example is BUILT BY another cluster, so the hook this teardown looks
    // for stands at that cluster's host — never at the one being torn down.
    ...portOver,
  };
}

function ctx(stepName: string, logs: string[], creds: CredentialStore = {} as unknown as CredentialStore): StepCtx {
  return {
    runId: "run_off", stepName, db: db.db, creds, params: { appId: "app_1" },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function seedApp(over: { repoCredentialId?: string } = {}): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "controller", status: "active", repoCredentialId: over.repoCredentialId ?? null }).run();
}

describe("offboard run definition", () => {
  it("plans with app targetKind, the ordered steps, and git-branch + master-kube locks", async () => {
    seedApp();
    const def = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage)));
    const plan = await def.plan({ appId: "app_1" }, { db: db.db });
    expect(def.mutating).toBe(true);
    expect(plan.targetKind).toBe("app");
    expect(plan.targetId).toBe("app_1");
    // delete-admission-policy sits right after watch-removal, BEFORE delete-appproject: the inverse of
    // apply-admission-policy, removed once the prune is confirmed. delete-namespace sits right after
    // delete-appproject: both tear down the consumer's empty shell (the AppProject on the master, the
    // namespace on the TARGET cluster). It MUST come after watch-removal — ArgoCD's CreateNamespace=true
    // never deletes the namespace on prune, so the Run deletes it, but only after the workloads are gone
    // (nothing live is stripped).
    // assert-no-orphans is the LAST step before record-offboard: it reads back everything the deletes
    // above were supposed to remove, and a leftover fails the run rather than settle the row.
    // remove-repo-pat runs AFTER the prune (the ArgoCD repository ESO may still need the PAT while
    // the Application is being removed) and BEFORE the orphan scan.
    // remove-app-secrets sits between them for two reasons, and BOTH are asserted by this order:
    // after watch-removal (the consumer's own pods read that entry via ESO until the app is pruned)
    // and before record-offboard (which flips the row to the re-onboardable state — a surviving
    // entry plus a re-onboardable row is the silent-inheritance bug, since the seed is cas=0).
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-registration", "watch-removal", "delete-admission-policy", "delete-appproject", "delete-repo-credential", "delete-build-rbac", "delete-namespace", "remove-dns", "remove-webhook", "remove-release-kit", "remove-repo-pat", "remove-app-secrets", "remove-database-secrets", "assert-no-orphans", "record-offboard"]);
    expect(plan.locks).toEqual([{ resource: "git-branch", key: FAKE_BOOKS_BRANCH }, { resource: "git-branch", key: "s1.example" }, { resource: "master-kube", key: "m" }]);
    expect(plan.requiredSecrets).toEqual([]);
  });

  it("removes the pointer, waits for the prune, and marks the row offboarded (kept)", async () => {
    seedApp();
    const platform = new FakePlatformRepo();
    const reg = new Registry(platform, prodClusterStage);
    await seedRegistration(reg); // a live consumer

    const logs: string[] = [];
    for (const step of makeOffboardDef(ports(reg)).steps({ appId: "app_1" })) await step.run(ctx(step.name, logs));

    expect(await reg.readRegistration("prod", "acme")).toBeNull(); // registration gone
    const row = db.db.select().from(apps).where(eq(apps.id, "app_1")).get();
    expect(row?.status).toBe("offboarded"); // soft state — row kept
    expect(row?.lastRunId).toBe("run_off");
    expect(logs.some((l) => l.includes("pruned"))).toBe(true);
  });

  // A move writes the relocation mark on the SOURCE namespace at repoint, and only a later move
  // ARRIVING there, or clear-source deleting the namespace, ever takes it off again. An abandoned move
  // therefore leaves it standing — and while it stands the service-provisioner KEEPS a claim's
  // databases instead of dropping them. remove-registration is what sets off the prune that hands the
  // claims to that teardown, so the mark has to be gone before it commits.
  it("remove-registration clears the relocation mark first — a stale mark must not make this offboard keep the data", async () => {
    seedApp();
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } });
    cluster.namespaceAnnotations.set("acme", { "platform.hostyour.cloud/relocating": "true" });
    const reg = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(reg);

    const logs: string[] = [];
    const remove = makeOffboardDef(ports(reg, { cluster })).steps({ appId: "app_1" }).find((s) => s.name === "remove-registration")!;
    await remove.run(ctx("remove-registration", logs));

    expect(cluster.namespaceAnnotations.get("acme")?.["platform.hostyour.cloud/relocating"]).toBeUndefined();
    // Order is the whole property: the mark is off BEFORE the commit that starts the prune.
    const cleared = logs.findIndex((l) => l.includes("platform.hostyour.cloud/relocating cleared"));
    const removed = logs.findIndex((l) => l.includes("registration for acme (prod) removed"));
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(cleared).toBeLessThan(removed);
  });

  it("delete-appproject removes the pre-seeded isolation AppProject (idempotent when absent)", async () => {
    seedApp();
    const projects = new FakeMasterProjectWriter();
    await projects.applyAppProject("argocd", renderConsumerAppProject({ name: "acme", namespace: "acme", repoURL: "https://github.com/x/acme.git", platformRepoURL: "https://github.com/x/hostyour-cloud.git", argoNamespace: "argocd" }));
    expect(projects.get("argocd", "acme")).toBeDefined();

    const reg = new Registry(new FakePlatformRepo(), prodClusterStage);
    const del = makeOffboardDef(ports(reg, { projects })).steps({ appId: "app_1" }).find((s) => s.name === "delete-appproject")!;
    await del.run(ctx("delete-appproject", []));
    expect(projects.get("argocd", "acme")).toBeUndefined();

    // idempotent: a second delete on the now-absent project does not throw
    await del.run(ctx("delete-appproject", []));
  });

  it("delete-build-rbac removes exactly the grants the onboard provisioned, and is idempotent when they are absent", async () => {
    seedApp();
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac(renderBuildRbac({ name: "acme", argoNamespace: "argocd" }));
    expect(buildRbac.keys()).toHaveLength(6);

    const reg = new Registry(new FakePlatformRepo(), prodClusterStage);
    const del = makeOffboardDef(ports(reg, { buildRbac })).steps({ appId: "app_1" }).find((s) => s.name === "delete-build-rbac")!;
    await del.run(ctx("delete-build-rbac", []));
    expect(buildRbac.keys()).toEqual([]);

    // idempotent: a second delete on the now-absent grants does not throw
    await del.run(ctx("delete-build-rbac", []));
  });

  it("delete-build-rbac is FAIL-SOFT — a writer that throws is logged and the teardown continues", async () => {
    seedApp();
    const throwing = { applyBuildRbac: () => Promise.reject(new Error("x")), deleteBuildRbac: () => Promise.reject(new Error("rbac api down")), listBuildRbac: () => Promise.resolve([]) };
    const reg = new Registry(new FakePlatformRepo(), prodClusterStage);
    const del = makeOffboardDef(ports(reg, { buildRbac: throwing })).steps({ appId: "app_1" }).find((s) => s.name === "delete-build-rbac")!;
    const logs: string[] = [];
    await del.run(ctx("delete-build-rbac", logs));
    expect(logs.some((l) => l.includes("rbac api down"))).toBe(true);
  });

  it("delete-namespace deletes the target-cluster namespace named for the consumer on the resolved target client", async () => {
    seedApp();
    // Hold the reference so we can assert WHICH namespace was deleted on the RESOLVED target client
    // (the slave's own reader for a slave, the master's for a master — never a master-only delete).
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { cluster })).steps({ appId: "app_1" }).find((s) => s.name === "delete-namespace")!;
    const logs: string[] = [];
    await step.run(ctx("delete-namespace", logs));

    // G1 identity law: namespace == consumer name. ArgoCD's CreateNamespace=true never prunes it, so
    // the Run must — otherwise the empty namespace lingers Active (the bug this step fixes).
    expect(cluster.deletedNamespaces).toEqual(["acme"]);
    expect(logs.some((l) => l.includes("namespace acme deleted on the target cluster"))).toBe(true);
  });

  it("delete-namespace is idempotent + fail-soft when the namespace is already absent (a re-run / ArgoCD already removed it)", async () => {
    seedApp();
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 }, absentNamespaces: ["acme"] });
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { cluster })).steps({ appId: "app_1" }).find((s) => s.name === "delete-namespace")!;
    const logs: string[] = [];
    await step.run(ctx("delete-namespace", logs)); // an absent namespace resolves deleted:false — no throw
    expect(cluster.deletedNamespaces).toEqual(["acme"]);
    expect(logs.some((l) => l.includes("already absent"))).toBe(true);
    // a second run stays a no-op (the crash-resume path)
    await step.run(ctx("delete-namespace", logs));
  });

  it("deletes the namespace only AFTER watch-removal (nothing live is stripped before the prune)", async () => {
    // The prune (watch-removal) throws when the workloads never go Missing, so a run that leaves them
    // lingering never reaches delete-namespace. Pin the ordering: it sits after watch-removal (and after
    // delete-appproject), so the delete only ever reaps the already-empty shell.
    seedApp();
    const steps = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage))).steps({ appId: "app_1" });
    const del = steps.findIndex((s) => s.name === "delete-namespace");
    expect(del).toBeGreaterThan(steps.findIndex((s) => s.name === "watch-removal"));
    expect(del).toBeGreaterThan(steps.findIndex((s) => s.name === "delete-appproject"));
  });

  it("remove-repo-pat deletes the local build-tier entry and revokes the sealed clone credential", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const seeder = new FakeSeeder();
    const revoked: Array<{ id: string; reason: string }> = [];
    const creds = { revoke: (id: string, reason: string) => { revoked.push({ id, reason }); return Promise.resolve(); } } as unknown as CredentialStore;
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { seeder })).steps({ appId: "app_1" }).find((s) => s.name === "remove-repo-pat")!;
    const logs: string[] = [];
    await step.run(ctx("remove-repo-pat", logs, creds));

    // The stage-free BUILD tier on the LOCAL Vault — the one place seed-repo-pat wrote: the
    // controller runs on the build-plane cluster, so there is no target-cluster address to resolve.
    expect(seeder.deleted).toEqual([{ consumerName: "acme" }]);
    expect(revoked).toEqual([{ id: "cred_pat", reason: "consumer acme offboarded" }]);
    expect(logs.some((l) => l.includes("secret/build/acme/repo-pat"))).toBe(true);
  });

  it("remove-repo-pat fails closed when the Vault delete fails (a lingering PAT is never silent)", async () => {
    seedApp();
    const failing: VaultSeeder = seederWith({ deleteBuildRepoPat: async () => { throw new Error("vault build repo-pat delete failed for secret/build/acme/repo-pat (403)"); } });
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { seeder: failing })).steps({ appId: "app_1" }).find((s) => s.name === "remove-repo-pat")!;
    await expect(step.run(ctx("remove-repo-pat", []))).rejects.toThrow(/repo-pat delete failed/);
  });

  it("remove-dns removes the unit's A record under the cluster's own apex, and an absent record is the no-op", async () => {
    seedApp();
    const dns = new FakeDnsProvider();
    // The default FakePlatformRepo values chain states unitApex == the branch (s1.example).
    dns.seed("acme.s1.example", "A", "203.0.113.10");
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { dns })).steps({ appId: "app_1" }).find((s) => s.name === "remove-dns")!;
    const logs: string[] = [];
    await step.run(ctx("remove-dns", logs));
    expect(dns.record("acme.s1.example", "A")).toBeUndefined();
    expect(logs.some((l) => l.includes("no address is left pointing nowhere"))).toBe(true);
    await step.run(ctx("remove-dns", logs)); // absent now — the idempotent no-op, no throw
  });

  it("remove-dns fails the run on a DNS API failure — an address left pointing nowhere is never silent", async () => {
    seedApp();
    const dns = new FakeDnsProvider();
    dns.failWith = new Error("Cloudflare DNS refused DELETE: [10000] Authentication error");
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { dns })).steps({ appId: "app_1" }).find((s) => s.name === "remove-dns")!;
    await expect(step.run(ctx("remove-dns", []))).rejects.toThrow(/Authentication error/);
  });

  it("delete-repo-credential removes the unit's ArgoCD repository Secret, fail-soft on a writer fault", async () => {
    seedApp();
    const deletedCreds: string[] = [];
    const repoCredential = {
      applyRepoCredential: async () => ({ created: true }), repoCredentialExists: async () => false,
      deleteRepoCredential: async (ns: string, name: string) => { deletedCreds.push(`${ns}/${name}`); return { deleted: true }; },
    };
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { repoCredential })).steps({ appId: "app_1" }).find((s) => s.name === "delete-repo-credential")!;
    await step.run(ctx("delete-repo-credential", []));
    expect(deletedCreds).toEqual(["argocd/repo-acme"]);

    const failing = { applyRepoCredential: async () => ({ created: true }), deleteRepoCredential: async () => { throw new Error("secrets api down"); }, repoCredentialExists: async () => false };
    const step2 = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { repoCredential: failing })).steps({ appId: "app_1" }).find((s) => s.name === "delete-repo-credential")!;
    const logs2: string[] = [];
    await step2.run(ctx("delete-repo-credential", logs2)); // fail-soft — logged, never a crash
    expect(logs2.some((l) => l.includes("secrets api down"))).toBe(true);
  });

  it("remove-app-secrets deletes the consumer-tier entry so a re-onboard cannot inherit the old keys", async () => {
    seedApp();
    const seeder = new FakeSeeder();
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { seeder })).steps({ appId: "app_1" }).find((s) => s.name === "remove-app-secrets")!;
    const logs: string[] = [];
    await step.run(ctx("remove-app-secrets", logs));

    // The CONSUMER tier (<stage>/consumer/<name>/app), not the app tier — a different Vault path
    // from remove-repo-pat's, which is the whole reason the old offboard missed it. toEqual is exact:
    // the step passes the stage and the name and nothing else, because there is one Vault and one
    // identity — the seeder logs in as the Controller itself.
    expect(seeder.deletedApp).toEqual([{ stage: "prod", consumerName: "acme" }]);
    expect(logs.some((l) => l.includes("secret/prod/consumer/acme/app"))).toBe(true);
  });

  it("remove-app-secrets fails closed when the Vault delete fails (a surviving entry would be inherited)", async () => {
    // Stronger than the repo-pat case: under the cas=0 create-only seed, a surviving entry is not
    // overwritten by the next onboard — it is inherited, silently, with created:false reported as a
    // benign no-op. Swallowing this error would reintroduce the bug the step exists to prevent.
    seedApp();
    const failing: VaultSeeder = seederWith({ deleteApp: async () => { throw new Error("vault app-secrets delete failed for secret/prod/consumer/acme/app (403)"); } });
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { seeder: failing })).steps({ appId: "app_1" }).find((s) => s.name === "remove-app-secrets")!;
    await expect(step.run(ctx("remove-app-secrets", []))).rejects.toThrow(/app-secrets delete failed/);
  });

  it("removes the app secrets BEFORE recording the row offboarded (a re-onboardable row never outlives the entry)", async () => {
    // Ordering is a correctness property, not cosmetics: record-offboard flips the row to the soft,
    // RE-ONBOARDABLE state. If the delete ran after it, a crash in between would leave a
    // re-onboardable row beside a live entry — exactly the silent-inheritance case. Prove the
    // sequence by observing when the row flips relative to the delete, not just by the name list.
    seedApp();
    let statusAtDelete: string | undefined;
    const seeder: VaultSeeder = seederWith({ deleteApp: async () => { statusAtDelete = db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status; } });
    const steps = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { seeder })).steps({ appId: "app_1" });
    const i = steps.findIndex((s) => s.name === "remove-app-secrets");
    const j = steps.findIndex((s) => s.name === "record-offboard");
    expect(i).toBeGreaterThan(steps.findIndex((s) => s.name === "watch-removal"));
    expect(i).toBeLessThan(j);

    for (const s of [steps[i]!, steps[j]!]) await s.run(ctx(s.name, []));
    expect(statusAtDelete).toBe("active"); // the delete saw a still-active row — it ran first
    expect(db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status).toBe("offboarded");
  });

  it("remove-database-secrets metadata-deletes the consumer-tier postgres leaf so a re-onboard cannot inherit the old superuser password", async () => {
    seedApp();
    const seeder = new FakeSeeder();
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { seeder })).steps({ appId: "app_1" }).find((s) => s.name === "remove-database-secrets")!;
    const logs: string[] = [];
    await step.run(ctx("remove-database-secrets", logs));
    // BOTH consumer-tier database leaves (<stage>/consumer/<name>/{postgres,mongodb}), DIFFERENT
    // Vault paths from remove-app-secrets (.../app) and remove-repo-pat (.../app/<name>/repo-pat).
    // Unconditional in both cases: this run cannot know what the manifest asked for.
    expect(seeder.deletedPostgres).toEqual([{ stage: "prod", consumerName: "acme" }]);
    expect(seeder.deletedMongodb).toEqual([{ stage: "prod", consumerName: "acme" }]);
    expect(logs.some((l) => l.includes("secret/prod/consumer/acme/{postgres,mongodb}"))).toBe(true);
  });

  it("remove-database-secrets fails closed when the Vault delete fails (a surviving leaf would be inherited under cas=0)", async () => {
    seedApp();
    const failing: VaultSeeder = seederWith({ deletePostgres: async () => { throw new Error("vault postgres-secret delete failed for secret/prod/consumer/acme/postgres (403)"); } });
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { seeder: failing })).steps({ appId: "app_1" }).find((s) => s.name === "remove-database-secrets")!;
    await expect(step.run(ctx("remove-database-secrets", []))).rejects.toThrow(/postgres-secret delete failed/);
  });

  it("removes the postgres secret AFTER watch-removal (the postgres pod + exporter read it via ESO until the app is pruned)", async () => {
    seedApp();
    const steps = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage))).steps({ appId: "app_1" });
    const pg = steps.findIndex((s) => s.name === "remove-database-secrets");
    expect(pg).toBeGreaterThan(steps.findIndex((s) => s.name === "watch-removal"));
    // grouped with the other consumer-tier Vault delete, right after it
    expect(pg).toBe(steps.findIndex((s) => s.name === "remove-app-secrets") + 1);
  });

  it("remove-webhook deletes the consumer's build webhook with the consumer PAT, at the build plane its cluster map names", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const github = new FakeGitHubConsumer();
    github.seedHook("x", "acme", BUILD_HOOK_URL); // where the onboard put it: s1's build plane
    const opened: string[] = [];
    const creds = { open: (id: string) => { opened.push(id); return Promise.resolve(Buffer.from("github_pat_test", "utf8")); } } as unknown as CredentialStore;
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { github })).steps({ appId: "app_1" }).find((s) => s.name === "remove-webhook")!;
    const logs: string[] = [];
    await step.run(ctx("remove-webhook", logs, creds));
    // The GitHub org/repo comes from the apps row's repo_url path (x/acme), NOT the human owner.
    expect(opened).toEqual(["cred_pat"]);
    expect(github.deletedCalls).toEqual([{ owner: "x", repo: "acme", token: "github_pat_test", ids: [1] }]);
    expect(github.hooksFor("x", "acme")).toEqual([]); // gone
    expect(logs.some((l) => l.includes("build webhook removed on x/acme"))).toBe(true);
    expect(logs.every((l) => !l.includes("github_pat_test"))).toBe(true); // the PAT is never logged
  });

  it("remove-webhook is FAIL-SOFT: a delete refusal logs a warning and never blocks offboard", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const github = new FakeGitHubConsumer();
    github.scopeError = true; // the PAT lost admin:repo_hook — must NOT crash the teardown
    const creds = { open: () => Promise.resolve(Buffer.from("github_pat_test", "utf8")) } as unknown as CredentialStore;
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { github })).steps({ appId: "app_1" }).find((s) => s.name === "remove-webhook")!;
    const logs: string[] = [];
    await expect(step.run(ctx("remove-webhook", logs, creds))).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("webhook NOT removed") && l.includes("by hand"))).toBe(true);
  });

  it("remove-webhook fail-soft skips when no webhook adapter is wired (never blocks offboard)", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage))).steps({ appId: "app_1" }).find((s) => s.name === "remove-webhook")!;
    const logs: string[] = [];
    await expect(step.run(ctx("remove-webhook", logs))).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("no GitHub consumer client is wired"))).toBe(true);
  });

  it("remove-webhook runs BEFORE remove-repo-pat so the sealed clone PAT is still openable", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const steps = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage))).steps({ appId: "app_1" });
    const w = steps.findIndex((s) => s.name === "remove-webhook");
    const r = steps.findIndex((s) => s.name === "remove-repo-pat");
    expect(w).toBeGreaterThan(-1);
    expect(w).toBeLessThan(r); // remove-repo-pat revokes the credential; the webhook delete must open it first
  });

  it("remove-release-kit git-rm's the release-kit's three paths from the consumer repo with the sealed PAT", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const consumerRepo = new FakeConsumerRepo();
    // The release-kit is present (committed at onboard) so the git-rm actually reaps it.
    for (const path of ["release/release.ps1", "release/release.sh", ".github/workflows/release.yml"]) consumerRepo.seed("https://github.com/x/acme.git", path, "kit");
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { consumerRepo })).steps({ appId: "app_1" }).find((s) => s.name === "remove-release-kit")!;
    const logs: string[] = [];
    await step.run(ctx("remove-release-kit", logs));
    // Opened the consumer repo (repo URL from the apps row, sealed PAT from repoCredentialId) and
    // recorded a remove of exactly the three release-kit paths — no writes.
    expect(consumerRepo.opened).toEqual([{ repoURL: "https://github.com/x/acme.git", credentialId: "cred_pat" }]);
    expect(consumerRepo.commits).toHaveLength(1);
    // The whole kit directory (stale files of older kits included) + the one owned workflow file.
    expect(consumerRepo.commits[0]!.remove).toEqual(["release", ".github/workflows/release.yml"]);
    expect(consumerRepo.commits[0]!.write).toBeUndefined();
    expect(logs.some((l) => l.includes("release-kit removed from"))).toBe(true);
  });

  it("remove-release-kit is FAIL-SOFT: a push refusal logs a warning and never blocks offboard", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const consumerRepo = new FakeConsumerRepo();
    consumerRepo.failCommit(new AppError("UPSTREAM", "git push failed: remote: Permission denied (403)"));
    const step = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage), { consumerRepo })).steps({ appId: "app_1" }).find((s) => s.name === "remove-release-kit")!;
    const logs: string[] = [];
    await expect(step.run(ctx("remove-release-kit", logs))).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("release-kit NOT removed") && l.includes("by hand"))).toBe(true);
  });

  it("a release-kit removal failure never blocks the rest of offboard (later steps still run, row offboarded)", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const reg = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(reg);
    const consumerRepo = new FakeConsumerRepo();
    consumerRepo.failOpen(new AppError("UPSTREAM", "clone failed: 403")); // the release-kit removal cannot even open the repo
    const creds = { revoke: () => Promise.resolve() } as unknown as CredentialStore;
    const logs: string[] = [];
    for (const step of makeOffboardDef(ports(reg, { consumerRepo })).steps({ appId: "app_1" })) await step.run(ctx(step.name, logs, creds));
    // The teardown completed despite the release-kit failure: the row is offboarded (record-offboard ran).
    expect(db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status).toBe("offboarded");
    expect(logs.some((l) => l.includes("release-kit NOT removed"))).toBe(true);
  });

  it("remove-release-kit runs BEFORE remove-repo-pat so the sealed clone PAT is still openable", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const steps = makeOffboardDef(ports(new Registry(new FakePlatformRepo(), prodClusterStage))).steps({ appId: "app_1" });
    const rk = steps.findIndex((s) => s.name === "remove-release-kit");
    const rp = steps.findIndex((s) => s.name === "remove-repo-pat");
    expect(rk).toBeGreaterThan(-1);
    expect(rk).toBeLessThan(rp); // remove-repo-pat revokes the credential; the git-rm must open it first
  });

  it("attest-target fails closed on a deploy-state domain mismatch", async () => {
    seedApp();
    const reg = new Registry(new FakePlatformRepo(), prodClusterStage);
    const prt = ports(reg, { cluster: new FakeClusterReader({ deployState: { domain: "other.example", stage: "prod", writtenAt: "x", generation: 1 } }) });
    const attest = makeOffboardDef(prt).steps({ appId: "app_1" })[0]!;
    await expect(attest.run(ctx("attest-target", []))).rejects.toThrow(/deploy-state mismatch/);
  });

  it("watch-removal fails when the app never prunes", async () => {
    seedApp();
    const platform = new FakePlatformRepo();
    const reg = new Registry(platform, prodClusterStage);
    await seedRegistration(reg);
    const prt = ports(reg, { argo: new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } }) });
    const steps = makeOffboardDef(prt).steps({ appId: "app_1" });
    await steps[0]!.run(ctx("attest-target", []));
    await steps[1]!.run(ctx("remove-registration", []));
    await expect(steps[2]!.run(ctx("watch-removal", []))).rejects.toThrow(/was not pruned/);
  });

  // remove-registration's resume-idempotency (the read-first skip after its own git commit) lives in
  // offboard-resume.run.test.ts — this file is at its line budget.
});
