import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { eq, and } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { makePurgeDef, type PurgePorts, type PurgeParams } from "./purge.run.ts";
import { renderSmtpOpsGrant } from "./build-rbac.ts";
import { Registrations, type ClusterStageResolver } from "./registrations.ts";
import { BUILD_HOOK_URL } from "./cluster-map.fixture.ts";
import { FakePlatformRepo, FAKE_BOOKS_BRANCH } from "../../adapters/git/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeConsumerRepo } from "../../adapters/git/testing/fake.ts";
import { AppError } from "../../kernel/errors.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultSeeder, VaultSeedOutcome, BuildRepoPatDeleteInput, AppSecretsDeleteInput, PostgresSecretDeleteInput, MongodbSecretDeleteInput } from "./vault-seeder.ts";

// purge (force-offboard by NAME) tests — mirrors offboard.run.test.ts conventions (the same fake
// kube/vault/git clients, the same in-memory DB). The load-bearing NEW properties purge must have and
// offboard does not: it removes a consumer's whole footprint from name+stage+cluster ALONE (no
// inventory row required — the orphaned-partial-onboard case), it is FAIL-SOFT (a missing artifact is
// fine, watch-removal never throws), and it is idempotent (a re-run is a no-op).

const SHA = "a".repeat(40);
const PARAMS: PurgeParams = { consumerName: "acme", stage: "prod", clusterId: "cls_1" };

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

// Every fixture purges from the prod stage, so a fixed resolver answers every cluster with "prod" —
// the stage boundary Registrations.commitRegistration checks before it ever writes a stage file.
const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

/** Commit acme's live STAGE registration on s1.example/prod — the purge target every test that
 *  needs a real registration to reap starts from. */
async function seedRegistration(reg: Registrations): Promise<void> {
  await reg.commitRegistration({
    unit: { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false },
    builds: [],
    deploy: { stage: "prod", chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
    runId: "run_onb",
  });
}

type FakeKube = { argo?: FakeMasterArgoReader; cluster?: FakeClusterReader; projects?: FakeMasterProjectWriter };

class FakeSeeder implements VaultSeeder {
  deleted: BuildRepoPatDeleteInput[] = [];
  deletedApp: AppSecretsDeleteInput[] = [];
  deletedPostgres: PostgresSecretDeleteInput[] = [];
  deletedMongodb: MongodbSecretDeleteInput[] = [];
  async seed(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds"); }
  async seedPostgres(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds postgres"); }
  async seedMongodb(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds mongodb"); }
  async seedBuildRepoPat(): Promise<VaultSeedOutcome> { throw new Error("purge never seeds a repo pat"); }
  async deleteBuildRepoPat(i: BuildRepoPatDeleteInput): Promise<void> { this.deleted.push(i); }
  async deleteApp(i: AppSecretsDeleteInput): Promise<void> { this.deletedApp.push(i); }
  async deletePostgres(i: PostgresSecretDeleteInput): Promise<void> { this.deletedPostgres.push(i); }
  async deleteMongodb(i: MongodbSecretDeleteInput): Promise<void> { this.deletedMongodb.push(i); }
  async seedTenantCrypto(): Promise<VaultSeedOutcome> { return { created: true }; }
  async deleteTenantCrypto(): Promise<void> {}
}

function ports(reg: Registrations, over: Partial<PurgePorts> & FakeKube = {}): PurgePorts {
  const { argo, cluster, projects, ...portOver } = over;
  return {
    registrations: reg,
    resolver: new FakeClusterKubeResolver({
      clusterReader: cluster ?? new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
      // Default: the app reads Missing (already pruned) — so watch-removal logs a clean prune.
      argoReader: argo ?? new FakeMasterArgoReader({ status: { syncRevision: null, targetRevision: null, sync: "Unknown", health: "Missing" } }),
      projectWriter: projects ?? new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    }),
    argoWatchTimeoutMs: 1000,
    seeder: new FakeSeeder(),
    dns: new FakeDnsProvider(),
    ...portOver,
  };
}

function ctx(stepName: string, logs: string[], creds: CredentialStore = {} as unknown as CredentialStore): StepCtx {
  return {
    runId: "run_purge", stepName, db: db.db, creds, params: { ...PARAMS },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

/** The cluster only (the master self-cluster) — NO app row. This is the ORPHAN precondition:
 *  an onboard that died before record-inventory left cluster/Vault artifacts but no inventory row. */
function seedCluster(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
}

/** The cluster PLUS the consumer's inventory row (a healthy, fully-onboarded consumer). */
function seedApp(over: { repoCredentialId?: string } = {}): void {
  seedCluster();
  db.db.insert(apps).values({ id: "app_1", clusterId: "cls_1", name: "acme", stage: "prod", repoUrl: "https://github.com/x/acme.git", chartPath: "deploy/chart", provenance: "manager", status: "active", repoCredentialId: over.repoCredentialId ?? null }).run();
}

async function runAll(prt: PurgePorts, logs: string[], creds?: CredentialStore): Promise<void> {
  for (const step of makePurgeDef(prt).steps(PARAMS)) await step.run(ctx(step.name, logs, creds));
}

const STEP_ORDER = ["attest-target", "remove-registration", "watch-removal", "delete-repo-credential", "delete-smtp-ops-grant", "delete-namespace", "remove-webhook", "remove-dns", "remove-release-kit", "remove-repo-pat", "remove-app-secrets", "remove-database-secrets", "assert-no-orphans", "record-purge"];

describe("purge run definition", () => {
  it("plans with cluster targetKind, the ordered steps, and git-branch + master-kube locks — with NO app row", async () => {
    seedCluster(); // orphan: cluster only, no apps row
    const def = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage)));
    const plan = await def.plan(PARAMS, { db: db.db });
    expect(def.mutating).toBe(true);
    // The app row may not exist (orphan), so purge targets the CLUSTER (like onboard's plan), not "app".
    expect(plan.targetKind).toBe("cluster");
    expect(plan.targetId).toBe("cls_1");
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_ORDER);
    expect(plan.locks).toEqual([{ resource: "git-branch", key: FAKE_BOOKS_BRANCH }, { resource: "git-branch", key: "s1.example" }, { resource: "master-kube", key: "m" }]);
    expect(plan.requiredSecrets).toEqual([]);
    expect(plan.summary).toContain("no inventory row"); // the plan states the orphan case plainly
  });

  it("mutating def starts with attest-target under empty params (the armed check does def.steps({}))", () => {
    // guards.assertGuardsArmed evaluates def.steps({})[0].name — building the steps must not deref
    // params, so this must not throw and the first step must be attest-target.
    expect(makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage))).steps({} as PurgeParams)[0]?.name).toBe("attest-target");
  });

  it("HEALTHY consumer: removes the registration, waits for the prune, and marks the row offboarded (kept)", async () => {
    seedApp();
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(reg); // a live consumer

    const logs: string[] = [];
    await runAll(ports(reg), logs);

    expect(await reg.readRegistration("prod", "acme")).toBeNull(); // registration gone
    const row = db.db.select().from(apps).where(eq(apps.id, "app_1")).get();
    expect(row?.status).toBe("offboarded"); // soft state — row kept
    expect(row?.lastRunId).toBe("run_purge");
    expect(logs.some((l) => l.includes("pruned"))).toBe(true);
  });

  it("ORPHAN (no inventory row): purges the whole cluster + Vault footprint by NAME and never throws", async () => {
    seedCluster(); // NO app row
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    // A partial onboard that reached write-registration but died before record-inventory: registration
    // present, NO row. Also pre-seed the mail-ops grant so delete-smtp-ops-grant has something to reap.
    await seedRegistration(reg);
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderSmtpOpsGrant({ name: "acme" })]);
    const seeder = new FakeSeeder();
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });

    const logs: string[] = [];
    await runAll(ports(reg, { buildRbac, seeder, cluster }), logs);

    // Every artifact reaped, by name, with no row anywhere:
    expect(await reg.readRegistration("prod", "acme")).toBeNull(); // registration gone
    expect(buildRbac.keys()).toEqual([]); // the mail-ops grant gone (the AppProject goes with the registration)
    expect(cluster.deletedNamespaces).toEqual(["acme"]); // namespace reaped (→ ServiceClaim → mongo deprovision)
    expect(seeder.deleted).toEqual([{ consumerName: "acme" }]); // repo PAT (the local build tier)
    expect(seeder.deletedApp).toEqual([{ stage: "prod", consumerName: "acme" }]); // ceremony secrets
    // record-purge is a clean no-op: there is no row to mark, and no row was invented.
    expect(db.db.select().from(apps).all()).toHaveLength(0);
    expect(logs.some((l) => l.includes("no inventory row"))).toBe(true);
  });

  it("refuses to record the row while a fail-soft delete left an object standing — the backstop settles nothing offboard would not", async () => {
    // An operator reaches for purge exactly when offboard refused at ITS scan. If purge flipped the row
    // without looking, the weaker run kind would settle the state the stricter one declined to: the
    // consumer would stop appearing as active while its mail-ops grant stood in the relay's namespace.
    seedApp();
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(reg);
    // The grant delete answers, but leaves the Role behind — the shape a fail-soft delete has after a
    // cluster-side refusal it only logged about.
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderSmtpOpsGrant({ name: "acme" })]);
    buildRbac.deleteBuildRbac = async () => ({ deleted: 0 });

    const logs: string[] = [];
    await expect(runAll(ports(reg, { buildRbac }), logs)).rejects.toThrow(/the consumer-purge of acme \(prod\) left 2 object\(s\) standing/);
    // The row stays active: a row saying the consumer left is what makes the leftover unfindable.
    expect(db.db.select().from(apps).get()?.status).toBe("active");
  });

  it("does NOT require an inventory row — the whole run is a no-op-safe teardown even when nothing exists", async () => {
    seedCluster(); // orphan died BEFORE write-registration: no registration, no grant, no namespace, no row
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 }, absentNamespaces: ["acme"] });
    const logs: string[] = [];
    // Nothing seeded beyond the cluster — every step must fail-soft and the run must complete.
    await expect(runAll(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { cluster }), logs)).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("already absent"))).toBe(true); // remove-registration no-op
  });

  it("remove-registration is idempotent when the registration is already absent (orphan died before write-registration)", async () => {
    seedCluster();
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage); // no registration committed
    const step = makePurgeDef(ports(reg)).steps(PARAMS).find((s) => s.name === "remove-registration")!;
    const logs: string[] = [];
    await step.run(ctx("remove-registration", logs)); // must not throw
    expect(logs.some((l) => l.includes("already absent"))).toBe(true);
  });

  it("watch-removal is FAIL-SOFT: it does NOT throw when the app never prunes (the core difference from offboard)", async () => {
    seedCluster();
    // Script the app Synced/Healthy (never Missing) — offboard would THROW "was not pruned"; purge
    // logs and continues, because delete-namespace force-reaps the workloads regardless.
    const argo = new FakeMasterArgoReader({ status: { syncRevision: SHA, targetRevision: null, sync: "Synced", health: "Healthy" } });
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { argo })).steps(PARAMS).find((s) => s.name === "watch-removal")!;
    const logs: string[] = [];
    await expect(step.run(ctx("watch-removal", logs))).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("not pruned") && l.includes("delete-namespace will force-reap"))).toBe(true);
    // It watched the GENERATED Application name (<name>-<stage>), never the bare name.
    expect(argo.watched).toEqual(["argocd/acme-prod"]);
  });

  it("delete-smtp-ops-grant reaps the pre-seeded mail-ops grant and is idempotent when absent", async () => {
    seedCluster();
    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderSmtpOpsGrant({ name: "acme" })]);
    const del = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { buildRbac })).steps(PARAMS).find((s) => s.name === "delete-smtp-ops-grant")!;
    await del.run(ctx("delete-smtp-ops-grant", []));
    expect(buildRbac.keys()).toEqual([]);
    await del.run(ctx("delete-smtp-ops-grant", [])); // second delete on the absent grant: no throw
  });

  it("delete-namespace deletes the target-cluster namespace named for the consumer, and is idempotent", async () => {
    seedCluster();
    const cluster = new FakeClusterReader({ deployState: { domain: "s1.example", stage: "prod", writtenAt: "x", generation: 1 } });
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { cluster })).steps(PARAMS).find((s) => s.name === "delete-namespace")!;
    const logs: string[] = [];
    await step.run(ctx("delete-namespace", logs));
    expect(cluster.deletedNamespaces).toEqual(["acme"]);
    expect(logs.some((l) => l.includes("namespace acme deleted") && l.includes("mongo deprovision"))).toBe(true);
    await step.run(ctx("delete-namespace", logs)); // re-run stays a no-op (already-absent → deleted:false)
  });

  it("remove-repo-pat deletes the local build-tier entry by NAME and revokes the sealed credential when a row carries one", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const seeder = new FakeSeeder();
    const revoked: Array<{ id: string; reason: string }> = [];
    const creds = { revoke: (id: string, reason: string) => { revoked.push({ id, reason }); return Promise.resolve(); } } as unknown as CredentialStore;
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { seeder })).steps(PARAMS).find((s) => s.name === "remove-repo-pat")!;
    await step.run(ctx("remove-repo-pat", [], creds));
    // The stage-free BUILD tier on the LOCAL Vault — the one place seed-repo-pat wrote.
    expect(seeder.deleted).toEqual([{ consumerName: "acme" }]);
    expect(revoked).toEqual([{ id: "cred_pat", reason: "consumer acme purged" }]);
  });

  it("remove-repo-pat still deletes the build-tier entry when there is NO row (nothing to revoke)", async () => {
    seedCluster(); // no app row → no sealed credential id recorded
    const seeder = new FakeSeeder();
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { seeder })).steps(PARAMS).find((s) => s.name === "remove-repo-pat")!;
    const logs: string[] = [];
    await step.run(ctx("remove-repo-pat", logs)); // must not need creds.revoke
    expect(seeder.deleted).toEqual([{ consumerName: "acme" }]);
    expect(logs.some((l) => l.includes("no inventory row"))).toBe(true);
  });

  it("remove-dns removes the unit's record and STILL fails the run on a DNS API failure (purge's one fail-closed teardown step)", async () => {
    seedCluster();
    const dns = new FakeDnsProvider();
    dns.seed("acme.s1.example", "A", "203.0.113.10"); // unitApex == the branch in the fake chain
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { dns })).steps(PARAMS).find((s) => s.name === "remove-dns")!;
    await step.run(ctx("remove-dns", []));
    expect(dns.record("acme.s1.example", "A")).toBeUndefined();

    const failingDns = new FakeDnsProvider();
    failingDns.failWith = new Error("Cloudflare DNS refused DELETE: [10000] Authentication error");
    const step2 = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { dns: failingDns })).steps(PARAMS).find((s) => s.name === "remove-dns")!;
    await expect(step2.run(ctx("remove-dns", []))).rejects.toThrow(/Authentication error/);
  });

  it("remove-webhook deletes the build webhook by NAME when a row carries the repo URL + PAT", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const github = new FakeGitHubConsumer();
    github.seedHook("x", "acme", BUILD_HOOK_URL);
    const opened: string[] = [];
    const creds = { open: (id: string) => { opened.push(id); return Promise.resolve(Buffer.from("github_pat_test", "utf8")); } } as unknown as CredentialStore;
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { github })).steps(PARAMS).find((s) => s.name === "remove-webhook")!;
    const logs: string[] = [];
    await step.run(ctx("remove-webhook", logs, creds));
    expect(opened).toEqual(["cred_pat"]);
    expect(github.deletedCalls[0]?.ids).toEqual([1]);
    expect(github.hooksFor("x", "acme")).toEqual([]);
    expect(logs.every((l) => !l.includes("github_pat_test"))).toBe(true);
  });

  it("remove-webhook fail-soft SKIPS for a true orphan (no inventory row → no repo URL / PAT)", async () => {
    seedCluster(); // NO app row — a true orphan
    const github = new FakeGitHubConsumer();
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { github })).steps(PARAMS).find((s) => s.name === "remove-webhook")!;
    const logs: string[] = [];
    await expect(step.run(ctx("remove-webhook", logs))).resolves.toBeUndefined();
    expect(github.deletedCalls).toEqual([]); // no PAT opened, nothing deleted
    expect(logs.some((l) => l.includes("webhook removal skipped") && l.includes("no inventory row"))).toBe(true);
  });

  it("remove-release-kit git-rm's the release-kit BY NAME when a row carries the repo URL + PAT", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const consumerRepo = new FakeConsumerRepo();
    // The release-kit is present (committed at onboard) so the git-rm actually reaps it.
    for (const path of ["release/release.ps1", "release/release.sh", ".github/workflows/release.yml"]) consumerRepo.seed("https://github.com/x/acme.git", path, "kit");
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { consumerRepo })).steps(PARAMS).find((s) => s.name === "remove-release-kit")!;
    const logs: string[] = [];
    await step.run(ctx("remove-release-kit", logs));
    expect(consumerRepo.opened).toEqual([{ repoURL: "https://github.com/x/acme.git", credentialId: "cred_pat" }]);
    expect(consumerRepo.commits).toHaveLength(1);
    // The whole kit directory (stale files of older kits included) + the one owned workflow file.
    expect(consumerRepo.commits[0]!.remove).toEqual(["release", ".github/workflows/release.yml"]);
    expect(logs.some((l) => l.includes("release-kit removed from"))).toBe(true);
  });

  it("remove-release-kit fail-soft SKIPS for a true orphan (no inventory row → no repo URL / PAT)", async () => {
    seedCluster(); // NO app row — a true orphan
    const consumerRepo = new FakeConsumerRepo();
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { consumerRepo })).steps(PARAMS).find((s) => s.name === "remove-release-kit")!;
    const logs: string[] = [];
    await expect(step.run(ctx("remove-release-kit", logs))).resolves.toBeUndefined();
    expect(consumerRepo.opened).toEqual([]); // never opened — nothing to remove
    expect(consumerRepo.commits).toEqual([]);
    expect(logs.some((l) => l.includes("release-kit removal skipped") && l.includes("no inventory row"))).toBe(true);
  });

  it("remove-release-kit is FAIL-SOFT: a push refusal never blocks the purge", async () => {
    seedApp({ repoCredentialId: "cred_pat" });
    const consumerRepo = new FakeConsumerRepo();
    consumerRepo.failCommit(new AppError("UPSTREAM", "git push failed: 403"));
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { consumerRepo })).steps(PARAMS).find((s) => s.name === "remove-release-kit")!;
    const logs: string[] = [];
    await expect(step.run(ctx("remove-release-kit", logs))).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("release-kit NOT removed") && l.includes("by hand"))).toBe(true);
  });

  it("remove-app-secrets deletes the consumer-tier entry so a re-onboard cannot inherit the old keys", async () => {
    seedCluster();
    const seeder = new FakeSeeder();
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { seeder })).steps(PARAMS).find((s) => s.name === "remove-app-secrets")!;
    const logs: string[] = [];
    await step.run(ctx("remove-app-secrets", logs));
    // The CONSUMER tier (<stage>/consumer/<name>/app), the different Vault path from the repo-pat's.
    expect(seeder.deletedApp).toEqual([{ stage: "prod", consumerName: "acme" }]);
    expect(logs.some((l) => l.includes("secret/prod/consumer/acme/app"))).toBe(true);
  });

  it("remove-database-secrets metadata-deletes the consumer-tier postgres leaf by NAME (unconditional, 404-tolerant no-op for a non-postgres consumer)", async () => {
    seedCluster(); // works even for a true orphan (no app row) — keyed on name+stage+cluster
    const seeder = new FakeSeeder();
    const step = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { seeder })).steps(PARAMS).find((s) => s.name === "remove-database-secrets")!;
    const logs: string[] = [];
    await step.run(ctx("remove-database-secrets", logs));
    // DIFFERENT leaves from remove-app-secrets (.../{postgres,mongodb} vs .../app). Both calls are
    // unconditional and both are a Vault no-op (404) for a consumer that ran on neither — that
    // tolerance lives in the seeder, asserted in vault-self-seeder.test.ts.
    expect(seeder.deletedPostgres).toEqual([{ stage: "prod", consumerName: "acme" }]);
    expect(seeder.deletedMongodb).toEqual([{ stage: "prod", consumerName: "acme" }]);
    expect(logs.some((l) => l.includes("secret/prod/consumer/acme/{postgres,mongodb}"))).toBe(true);
  });

  it("is idempotent + fail-soft on a RE-RUN: a full purge twice over reaps once and never throws", async () => {
    seedApp();
    const reg = new Registrations(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(reg);
    const seeder = new FakeSeeder();
    const logs: string[] = [];
    await runAll(ports(reg, { seeder }), logs);
    // Second full pass: registration already gone, namespace/appproject already gone, row already offboarded.
    await expect(runAll(ports(reg, { seeder }), logs)).resolves.toBeUndefined();
    const row = db.db.select().from(apps).where(and(eq(apps.clusterId, "cls_1"), eq(apps.name, "acme"))).get();
    expect(row?.status).toBe("offboarded"); // still offboarded, still kept
  });

  // purge is keyed on ONE stage (name + stage + cluster), so it obeys the same per-stage/per-unit split
  // offboard does: force-removing prod must leave a unit that still stands at dev able to build and
  // release. Proven through the same shared objects — the `acme-build` grants, the ONE build webhook,
  // the release kit, secret/build/acme/repo-pat.
  it("purging ONE stage of a two-stage unit keeps everything the other stage needs", async () => {
    seedApp({ repoCredentialId: "cred_prod" });
    const platform = new FakePlatformRepo();
    // A cluster carries exactly one stage, so the unit's second stage stands on s2/dev.
    const reg = new Registrations(platform, async (cluster) => ({ name: cluster, stage: cluster === "s2" ? "dev" : "prod" }));
    const unit = { name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false };
    for (const deploy of [{ stage: "prod" as const, cluster: "s1" }, { stage: "dev" as const, cluster: "s2" }]) {
      await reg.commitRegistration({ unit, builds: ["acme"], deploy: { ...deploy, chartPath: "deploy/chart", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") }, runId: `run_onb_${deploy.stage}` });
    }

    const buildRbac = new FakeBuildRbacWriter();
    await buildRbac.applyBuildRbac([renderSmtpOpsGrant({ name: "acme" })]);
    const github = new FakeGitHubConsumer();
    github.seedHook("x", "acme", BUILD_HOOK_URL);
    const consumerRepo = new FakeConsumerRepo();
    consumerRepo.seed("https://github.com/x/acme.git", "release/release.sh", "kit");
    const seeder = new FakeSeeder();
    const creds = {
      open: () => Promise.resolve(Buffer.from("github_pat_test", "utf8")),
      revoke: () => Promise.resolve(),
    } as unknown as CredentialStore;

    const logs: string[] = [];
    await runAll(ports(reg, { buildRbac, github, consumerRepo, seeder }), logs, creds);

    // prod is gone; dev keeps its registration, the unit keeps its build declaration.
    expect(await reg.readRegistration("prod", "acme")).toBeNull();
    expect(await reg.readRegistration("dev", "acme")).not.toBeNull();
    expect(platform.read(platform.booksBranch, "registrations/acme/build.yaml")).not.toBeNull();
    // The mail-ops grant is the UNIT's, and the unit still stands at dev, so it stays exactly where it
    // is: taking it here would blind the surviving stage's queue dashboard to the relay it was granted.
    expect(buildRbac.keys()).toEqual([
      "Role postfix/acme-smtp-ops",
      "RoleBinding postfix/acme-smtp-ops",
    ]);
    expect(github.hooksFor("x", "acme")).toHaveLength(1);
    expect(consumerRepo.commits).toEqual([]);
    expect(seeder.deleted).toEqual([]);
    expect(logs.filter((l) => l.includes("stays registered at dev"))).toHaveLength(4);
  });

  it("attest-target fails closed on a deploy-state domain mismatch (never purge the wrong cluster)", async () => {
    seedCluster();
    const prt = ports(new Registrations(new FakePlatformRepo(), prodClusterStage), { cluster: new FakeClusterReader({ deployState: { domain: "other.example", stage: "prod", writtenAt: "x", generation: 1 } }) });
    const attest = makePurgeDef(prt).steps(PARAMS)[0]!;
    await expect(attest.run(ctx("attest-target", []))).rejects.toThrow(/deploy-state mismatch/);
  });

  it("plan fails closed on a stage that disagrees with the target cluster's own stage", async () => {
    seedCluster(); // cls_1 is prod
    const def = makePurgeDef(ports(new Registrations(new FakePlatformRepo(), prodClusterStage)));
    await expect(def.plan({ consumerName: "acme", stage: "dev", clusterId: "cls_1" }, { db: db.db })).rejects.toThrow(/stage mismatch/);
  });
});
