import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, apps } from "../../db/schema/inventory.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { Registry, serializePointer, type ClusterStageResolver } from "./registry.ts";
import { scanClusterOrphanConsumers, scanDetectedConsumers } from "./consumer-detected.ts";
import { FakeClusterKubeResolver, FakeClusterReader, FakeMasterArgoReader, FakeMasterProjectWriter } from "../../adapters/kube/testing/fake.ts";
import type { SmokeResult } from "../../adapters/kube/port.ts";
import { ConsumerRegistrationSchema } from "../../../shared/consumer.ts";
import type { Stage } from "../../../shared/enums.ts";

// The DISCOVERY half of surfacing untracked consumers: what makes one nameable at all — the
// consumer twin of tenant-orphans.test.ts, pinning the same load-bearing properties: the DIFF
// (inventory vs the live GitOps registrations), the settled-rows-count-as-absent rule, and the honesty
// of what the diff yields (a registration the scan cannot read surfaces in `skipped`, never in silence —
// the scan reads ONLY the registration side, so everything it returns is the registration's claim, not
// "running").

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  // ONE registered ACTIVE cluster — the master self-cluster shape purge.run.test.ts seeds; consumers
  // land on any active cluster, m1 included. Its SHORT NAME is "s1" — the
  // stage registration's own `cluster` field, which the scan selects on.
  db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
});
afterEach(() => db.sqlite.close());

// Every fixture registers at the prod stage, so a fixed resolver answers every cluster with "prod" —
// the stage boundary Registry.commitRegistration checks before it ever writes a stage file.
const prodClusterStage: ClusterStageResolver = async (cluster) => ({ name: cluster, stage: "prod" });

/** Commit `name`'s live STAGE registration, targeting cluster short name `cluster` at `stage`. */
async function seedRegistration(
  registry: Registry,
  name: string,
  opts: { cluster: string; stage?: Stage; suspended?: boolean; repoCredentialId?: string; owner?: string; onboardedAt?: string },
): Promise<void> {
  await registry.commitRegistration({
    unit: {
      name, repoURL: `https://github.com/x/${name}.git`,
      suspended: opts.suspended ?? false, quiesced: false,
      ...(opts.repoCredentialId ? { repoCredentialId: opts.repoCredentialId } : {}),
      ...(opts.owner ? { owner: opts.owner } : {}),
      ...(opts.onboardedAt ? { onboardedAt: opts.onboardedAt } : {}),
    },
    builds: [],
    deploy: { stage: opts.stage ?? "prod", chartPath: "deploy/chart", cluster: opts.cluster, databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small") },
    runId: `run_${name}`,
  });
}

/** An apps row for `name` on cls_1 — the inventory side of the diff. */
function seedApp(name: string, over: { status?: "active" | "suspended" | "offboarded" } = {}): void {
  db.db
    .insert(apps)
    .values({ id: `app_${name}`, clusterId: "cls_1", name, stage: "prod", repoUrl: `https://github.com/x/${name}.git`, chartPath: "deploy/chart", provenance: "controller", status: over.status ?? "active" })
    .run();
}

describe("scanDetectedConsumers (the registration-vs-inventory diff)", () => {
  it("returns only the registrations inventory does not know, carrying ONLY the registration side", async () => {
    seedApp("acme"); // tracked — must not be detected
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(registry, "acme", { cluster: "s1" });
    await seedRegistration(registry, "ghost", { cluster: "s1" });
    expect(await scanDetectedConsumers({ db: db.db, registry })).toEqual({
      detected: [{
        name: "ghost", stage: "prod", clusterId: "cls_1", domain: "s1.example",
        // The registration's CLAIM verbatim — no live probe happens in the bulk scan.
        pointer: { repoURL: "https://github.com/x/ghost.git", chartPath: "deploy/chart", cluster: "s1", suspended: false, quiesced: false },
      }],
      skipped: [],
    });
  });

  it("carries the registration's optional fields verbatim when present (repoCredentialId/owner/onboardedAt)", async () => {
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(registry, "ghost", { cluster: "s1", repoCredentialId: "cred_ptr", owner: "team-x", onboardedAt: "2026-01-01T00:00:00Z" });
    const scan = await scanDetectedConsumers({ db: db.db, registry });
    expect(scan.detected[0]?.pointer).toEqual({
      repoURL: "https://github.com/x/ghost.git", chartPath: "deploy/chart", cluster: "s1", suspended: false, quiesced: false,
      repoCredentialId: "cred_ptr", owner: "team-x", onboardedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("finds nothing when every deployed registration has a row, and nothing when nothing is deployed", async () => {
    seedApp("acme");
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(registry, "acme", { cluster: "s1" });
    expect(await scanDetectedConsumers({ db: db.db, registry })).toEqual({ detected: [], skipped: [] });
    expect(await scanDetectedConsumers({ db: db.db, registry: new Registry(new FakePlatformRepo(), prodClusterStage) })).toEqual({ detected: [], skipped: [] });
  });

  it("a SUSPENDED row still counts as known — a paused consumer is on the Consumers list, not invisible", async () => {
    seedApp("acme", { status: "suspended" });
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(registry, "acme", { cluster: "s1" });
    expect((await scanDetectedConsumers({ db: db.db, registry })).detected).toEqual([]);
  });

  it("treats an OFFBOARDED row as absent — a live registration beside it is leftover state (or a re-deploy), not accounted for", async () => {
    // APP_SETTLED_STATUS, the consumer twin of the tenant scan's TENANT_SETTLED_STATUS rule: the row
    // records a removal that already ran, so it cannot vouch for a registration standing NOW.
    seedApp("acme", { status: "offboarded" });
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(registry, "acme", { cluster: "s1" });
    const found = await scanDetectedConsumers({ db: db.db, registry });
    expect(found.detected.map((d) => d.name)).toEqual(["acme"]);
  });

  it("reports a registration with suspended:true carrying that field verbatim — the record of intent, never read as 'should be running'", async () => {
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(registry, "ghost", { cluster: "s1", suspended: true });
    const found = await scanDetectedConsumers({ db: db.db, registry });
    expect(found.detected).toHaveLength(1);
    expect(found.detected[0]).toMatchObject({ name: "ghost", pointer: { suspended: true } });
  });

  it("scans ONLY active clusters — a planned/removed cluster's registration is not selected", async () => {
    db.db.insert(servers).values({ id: "srv_2", name: "s9", host: "1.2.3.5", sshUser: "root", role: "slave", status: "bare" }).run();
    db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s9.example", status: "planned" }).run();
    // The registration targets the PLANNED cluster's short name only — an active-clusters scan must
    // never select it (cls_1 is the only active cluster, and it selects on ITS OWN short name "s1").
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(registry, "ghost", { cluster: "s9" });
    expect(await scanDetectedConsumers({ db: db.db, registry })).toEqual({ detected: [], skipped: [] });
  });

  it("is cluster-scoped: a row on ANOTHER cluster never covers this cluster's registration", async () => {
    db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "1.2.3.5", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", status: "active" }).run();
    // ghost is TRACKED on cls_2 but its registration targets cls_1 ("s1") — that deployment is unknown.
    db.db.insert(apps).values({ id: "app_ghost2", clusterId: "cls_2", name: "ghost", stage: "prod", provenance: "controller", status: "active" }).run();
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(registry, "ghost", { cluster: "s1" });
    const found = await scanDetectedConsumers({ db: db.db, registry });
    expect(found.detected.map((d) => `${d.clusterId}/${d.name}`)).toEqual(["cls_1/ghost"]);
  });

  it("reports a registration it could NOT read instead of dropping it — an empty list must mean 'checked'", async () => {
    const repo = new FakePlatformRepo();
    const registry = new Registry(repo, prodClusterStage);
    await seedRegistration(registry, "ghost", { cluster: "s1" });
    // A hand-written/drifted file no writer of ours would produce: flat YAML, but failing the schema.
    // Registrations live on `master` (REGISTRATION_BRANCH), never on a cluster's own install branch.
    repo.seed(repo.booksBranch, "registrations/broken/prod.yaml", 'name: "broken"\nrepoURL: "not-a-git-url"\n');
    const found = await scanDetectedConsumers({ db: db.db, registry });
    expect(found.detected.map((d) => d.name)).toEqual(["ghost"]); // the readable one is still found
    expect(found.skipped).toHaveLength(1);
    expect(found.skipped[0]).toMatchObject({ name: "broken", stage: "prod" });
    expect(found.skipped[0]!.reason).toContain("failed its schema");
  });

  it("never hands out a registration whose BODY name disagrees with its directory name — it reports it instead", async () => {
    // An adopt (or purge) aimed at the body's name would act on THAT namespace/AppProject and leave
    // the actual file — at this path — untouched. The path is the identity; the body is refused.
    const repo = new FakePlatformRepo();
    const registry = new Registry(repo, prodClusterStage);
    repo.seed(repo.booksBranch, "registrations/ghost/prod.yaml", serializePointer(ConsumerRegistrationSchema, {
      name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false,
      chartPath: "deploy/chart", cluster: "s1", databases: [], services: [], size: "small", mongodb: "shared", quota: seedQuota("small"),
    }));
    const found = await scanDetectedConsumers({ db: db.db, registry });
    expect(found.detected).toEqual([]); // NOT { name: "acme", … } at the path of ghost
    expect(found.skipped).toHaveLength(1);
    expect(found.skipped[0]).toMatchObject({ name: "ghost", stage: "prod" });
    expect(found.skipped[0]!.reason).toContain('body name ("acme") disagrees with its directory name ("ghost")');
  });

  it("reports unparseable registration bytes with the reason, never a throw that wedges the scan", async () => {
    const repo = new FakePlatformRepo();
    const registry = new Registry(repo, prodClusterStage);
    await seedRegistration(registry, "ghost", { cluster: "s1" });
    repo.seed(repo.booksBranch, "registrations/junk/prod.yaml", "no colon on this line\n");
    const found = await scanDetectedConsumers({ db: db.db, registry });
    expect(found.detected.map((d) => d.name)).toEqual(["ghost"]);
    expect(found.skipped[0]).toMatchObject({ name: "junk", stage: "prod" });
    expect(found.skipped[0]!.reason).toContain("not readable registration YAML");
  });

  it("propagates a registry failure instead of answering an empty list", async () => {
    // Fail-soft is the ROUTE's job (it renders "the scan failed"); flattening it here would make an
    // unreachable install branch read as "none detected" — the exact opposite of the truth.
    const registry = { listConsumerRegistrations: () => Promise.reject(new Error("install branch unreachable")) } as unknown as Registry;
    await expect(scanDetectedConsumers({ db: db.db, registry })).rejects.toThrow("install branch unreachable");
  });
});

describe("scanClusterOrphanConsumers (the cluster-vs-both-books diff)", () => {
  const SELECTOR = "hostyour.cloud/consumer=true";

  /** A resolver whose ONE cluster (cls_1) holds `namespaces`, each smoked as scripted. */
  function resolverHolding(namespaces: readonly string[], smokeByNamespace: Record<string, SmokeResult> = {}): FakeClusterKubeResolver {
    return new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ namespacesByLabel: { [SELECTOR]: namespaces }, smokeByNamespace }),
      argoReader: new FakeMasterArgoReader(),
      projectWriter: new FakeMasterProjectWriter(),
      argoNamespace: "argocd",
    });
  }

  const running = (n: number): SmokeResult => ({
    namespaceExists: true,
    workloads: Array.from({ length: n }, (_, i) => ({ kind: "Deployment", name: `w${i}`, available: true, desired: 1, ready: 1 })),
    externalSecretsReady: true,
  });

  it("finds the consumer NO book knows — the case the registration diff cannot even express", async () => {
    // THE founding case: the registration was removed, the workloads were never pruned. The
    // registration diff starts from the registrations, so it reports nothing and is not wrong; this
    // one starts from the cluster and finds the namespace that is still serving.
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    const found = await scanClusterOrphanConsumers({ db: db.db, registry, resolver: resolverHolding(["ghost"], { ghost: running(2) }) });
    expect(found.unscanned).toEqual([]);
    expect(found.clusterOrphans).toEqual([
      { name: "ghost", stage: "prod", clusterId: "cls_1", domain: "s1.example", running: 2, workloads: 2, externalSecretsReady: true },
    ]);
    // And the registration diff, over the same world, is silent — which is the whole point.
    expect((await scanDetectedConsumers({ db: db.db, registry })).detected).toEqual([]);
  });

  it("subtracts BOTH books: a namespace with an inventory row and one with a registration are not orphans", async () => {
    // A namespace with a ROW is on the Consumers list; a namespace with a REGISTRATION is already
    // reported by scanDetectedConsumers with a pointer and an adopt button. Reporting either here
    // would put the same consumer on screen twice under two different remedies.
    seedApp("tracked");
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    await seedRegistration(registry, "registered", { cluster: "s1" });
    const found = await scanClusterOrphanConsumers({
      db: db.db, registry, resolver: resolverHolding(["tracked", "registered", "ghost"]),
    });
    expect(found.clusterOrphans.map((o) => o.name)).toEqual(["ghost"]);
  });

  it("an OFFBOARDED row does not vouch for a namespace that is still standing", async () => {
    // The same settled-rows-count-as-absent rule the registration diff obeys, and here it is the
    // load-bearing one: an offboard that recorded the row but never reaped the namespace is exactly
    // the leftover this scan exists to surface.
    seedApp("acme", { status: "offboarded" });
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    const found = await scanClusterOrphanConsumers({ db: db.db, registry, resolver: resolverHolding(["acme"], { acme: running(0) }) });
    expect(found.clusterOrphans).toHaveLength(1);
    expect(found.clusterOrphans[0]).toMatchObject({ name: "acme", running: 0, workloads: 0 });
  });

  it("reports how many workloads are actually READY — the difference between a leak and a leftover", async () => {
    // A count of workloads cannot tell the two apart: a suspended unit renders 0 of 0 and reads
    // "available" too. The ready count is what decides whether somebody's customer is still being
    // served by something the platform does not know it runs.
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    const found = await scanClusterOrphanConsumers({
      db: db.db,
      registry,
      resolver: resolverHolding(["serving", "empty"], {
        serving: running(3),
        empty: { namespaceExists: true, workloads: [], externalSecretsReady: false },
      }),
    });
    expect(found.clusterOrphans).toEqual([
      { name: "serving", stage: "prod", clusterId: "cls_1", domain: "s1.example", running: 3, workloads: 3, externalSecretsReady: true },
      { name: "empty", stage: "prod", clusterId: "cls_1", domain: "s1.example", running: 0, workloads: 0, externalSecretsReady: false },
    ]);
  });

  it("a workload with replicas but NONE ready is not counted as running", async () => {
    // ImagePullBackOff / CrashLoopBackOff: the namespace holds a workload, nothing serves. Counting
    // it as running would tell an operator a leak is live when it is not.
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    const found = await scanClusterOrphanConsumers({
      db: db.db,
      registry,
      resolver: resolverHolding(["stuck"], {
        stuck: { namespaceExists: true, workloads: [{ kind: "Deployment", name: "api", available: false, desired: 2, ready: 0, message: "ImagePullBackOff" }], externalSecretsReady: true },
      }),
    });
    expect(found.clusterOrphans[0]).toMatchObject({ name: "stuck", running: 0, workloads: 1 });
  });

  it("carries a cluster it could NOT read out as unscanned, and keeps scanning the others", async () => {
    // Silence read as an all-clear is the failure this whole scan exists to end, so an unreachable
    // slave gets named — while every other cluster still answers.
    db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "1.2.3.6", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: "prod", domain: "s2.example", status: "active" }).run();
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    const resolver = resolverHolding(["ghost"], { ghost: running(1) });
    resolver.set("cls_2", {
      clusterReader: new FakeClusterReader({ throwOnListNamespaces: new Error("dial tcp 100.64.0.11:16443: connect: no route to host") }),
      argoReader: new FakeMasterArgoReader(), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "s2",
    });
    const found = await scanClusterOrphanConsumers({ db: db.db, registry, resolver });
    expect(found.clusterOrphans.map((o) => o.name)).toEqual(["ghost"]);
    expect(found.unscanned).toHaveLength(1);
    expect(found.unscanned[0]).toMatchObject({ clusterId: "cls_2", domain: "s2.example", stage: "prod" });
    expect(found.unscanned[0]!.reason).toContain("no route to host");
  });

  it("refuses a cluster whose registrations cannot be read, instead of calling every consumer on it an orphan", async () => {
    // Without the registration names there is nothing to subtract, so every healthy consumer would be
    // listed as untracked — the loudest possible false positive. The cluster goes to unscanned.
    const registry = { listConsumerRegistrations: () => Promise.reject(new Error("install branch unreachable")) } as unknown as Registry;
    const found = await scanClusterOrphanConsumers({ db: db.db, registry, resolver: resolverHolding(["acme", "ghost"]) });
    expect(found.clusterOrphans).toEqual([]);
    expect(found.unscanned[0]).toMatchObject({ clusterId: "cls_1" });
    expect(found.unscanned[0]!.reason).toContain("install branch unreachable");
  });

  it("subtracts a registration it could not PARSE by its directory name", async () => {
    // The body was unreadable, the directory name was not — and that name IS the identity. Without
    // this, a namespace whose registration is merely broken reads as having none at all.
    const repo = new FakePlatformRepo();
    const registry = new Registry(repo, prodClusterStage);
    repo.seed(repo.booksBranch, "registrations/junk/prod.yaml", "no colon on this line\n");
    const found = await scanClusterOrphanConsumers({ db: db.db, registry, resolver: resolverHolding(["junk", "ghost"]) });
    expect(found.clusterOrphans.map((o) => o.name)).toEqual(["ghost"]);
  });

  it("scans ONLY active clusters, and answers empty for a cluster holding no consumer namespace", async () => {
    db.db.insert(servers).values({ id: "srv_3", name: "s3", host: "1.2.3.7", sshUser: "root", role: "slave", status: "bare" }).run();
    db.db.insert(clusters).values({ id: "cls_3", serverId: "srv_3", stage: "prod", domain: "s3.example", status: "planned" }).run();
    const registry = new Registry(new FakePlatformRepo(), prodClusterStage);
    const found = await scanClusterOrphanConsumers({ db: db.db, registry, resolver: resolverHolding([]) });
    expect(found).toEqual({ clusterOrphans: [], unscanned: [] });
  });
});
