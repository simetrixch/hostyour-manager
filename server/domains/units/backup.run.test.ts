import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../../db/client.ts";
import { apps, tenants } from "../../db/schema/inventory.ts";
import { makeBackupDef, makeTenantBackupDef } from "./backup.run.ts";
import { FAKE_BOOKS_BRANCH } from "../../adapters/git/testing/fake.ts";
import { listBackups } from "../../db/unit-backups.ts";
import {
  openFixtureDb, seedClusters, seedMaster, seedConsumerRow, seedTenantRows, seedConsumerRegistration, seedTenantWorld,
  makeFakes, consumerPorts, tenantPorts, driveSteps, jobNames, stepCtx, GUID, CONSUMER, SOURCE, INSTALLATION,
} from "./relocation.fixture.ts";

// backup / tenant-backup — the first half of the ONE relocation mechanism, run for its own sake. The
// journey both defs must satisfy: a backup LEAVES THE UNIT RUNNING — access is closed and
// measured closed only for the dump, then reopened, a new generation stays on the box, and nothing
// of the unit's state (row, registration, cluster objects) is any different afterwards.

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); });
afterEach(() => { db.sqlite.close(); });

const STEP_ORDER = ["attest-target", "quiesce", "verify-quiesced", "dump", "verify-dump", "open-access"];

describe("backup (consumer)", () => {
  it("plans the backup half in order, with the registration + master locks", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    const plan = await makeBackupDef(ports).plan({ appId: "app_1" }, { db: db.db });
    expect(plan.targetKind).toBe("app");
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_ORDER);
    expect(plan.locks).toEqual([
      { resource: "git-branch", key: FAKE_BOOKS_BRANCH },
      { resource: "git-branch", key: SOURCE.domain },
      { resource: "master-kube", key: "m" },
    ]);
    expect(plan.summary).toContain("STAYS");
  });

  it("journey: a backup leaves the unit running — quiesce is flipped back, the row is untouched, and the dump jobs filled a new generation", async () => {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);

    const logs: string[] = [];
    await driveSteps(db, f, makeBackupDef(ports).steps({ appId: "app_1" }), { appId: "app_1" }, logs);

    // The registration ends OPEN — quiesced held only for the dump.
    expect((await ports.registrations.readRegistration("prod", CONSUMER))?.entry.quiesced).toBe(false);
    // The row is untouched: a backup changes nothing about where or whether the unit runs.
    expect(db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status).toBe("active");
    // Access was MEASURED closed on the unit's public host, never assumed.
    expect(f.probe.probed).toEqual([`https://${CONSUMER}.${SOURCE.domain}/`]);
    // The dump ran where the stores are (the registration copy in the unit ns, mongo in the platform
    // ns), the manifest was laid last and the generation verified; nothing cleared anything.
    const names = jobNames(f.source);
    expect(names).toContain(`reloc-dump-reg-${CONSUMER}`);
    expect(names).toContain(`reloc-dump-mongo-${CONSUMER}`);
    expect(names).toContain(`reloc-manifest-${CONSUMER}`);
    expect(names).toContain(`reloc-verify-dump-${CONSUMER}`);
    expect(names.find((n) => n.startsWith("reloc-clear-source"))).toBeUndefined();
    expect(jobNames(f.target)).toEqual([]);
    // One generation, entered in the book and restorable, filed under the installation, the stage and the kind.
    const [g, ...more] = listBackups(db.db, { kind: "consumer", unit: CONSUMER, stage: "prod" });
    expect(more).toEqual([]);
    expect(g).toMatchObject({ trigger: "manual", state: "ok", runId: "run_reloc" });
    expect(g!.folder).toBe(`${INSTALLATION}/prod/consumers/${CONSUMER}/${g!.generation}`);
    const verify = f.source.reader.jobs.find((j) => j.spec.name === `reloc-verify-dump-${CONSUMER}`);
    expect(verify?.spec.script).toContain(`"manifest.txt"`);
  });

  it("verify-quiesced fails LOUD when the public address still answers — a chart that ignored the flag", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    f.probe.set(`https://${CONSUMER}.${SOURCE.domain}/`, { reachable: true, status: 200, detail: "HTTP 200" });

    const steps = makeBackupDef(ports).steps({ appId: "app_1" });
    await expect(driveSteps(db, f, steps, { appId: "app_1" }, [])).rejects.toThrow(/still answers/);
    // Nothing was dumped: the measurement stopped the run before any store was touched.
    expect(jobNames(f.source).find((n) => n.startsWith("reloc-dump"))).toBeUndefined();
  });

  it("the dump fails LOUD when the storage box is not wired", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = { ...consumerPorts(f) };
    delete (ports as { storageBox?: unknown }).storageBox;
    await seedConsumerRegistration(ports.registrations);
    await expect(driveSteps(db, f, makeBackupDef(ports).steps({ appId: "app_1" }), { appId: "app_1" }, [])).rejects.toThrow(/storage-box/);
  });
});

describe("tenant-backup", () => {
  it("journey: a backup leaves the tenant running, and the dump covers every store of the bracket", async () => {
    seedMaster(db);
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);

    const def = makeTenantBackupDef(ports);
    const plan = await def.plan({ tenantId: "tnt_1" }, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_ORDER);

    const logs: string[] = [];
    await driveSteps(db, f, def.steps({ tenantId: "tnt_1" }), { tenantId: "tnt_1" }, logs);

    expect((await ports.registrations.readTenant("prod", GUID))?.entry.quiesced).toBe(false);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("active");
    // The complete data scope: every <guid>_* database, the crypto material, and — the tenant has an
    // app, so a bucket exists — the object storage, then the folder verification.
    const names = jobNames(f.source);
    expect(names).toContain(`reloc-dump-mongo-${GUID}`);
    expect(names).toContain(`reloc-dump-crypto-${GUID}`);
    expect(names).toContain(`reloc-dump-bucket-${GUID}`);
    // The fifth crypto property. Its own job because it is in its own Secret in its own namespace —
    // the kit renders hostyour-engine-api-key only where it is read, which is not the IdP member.
    expect(names).toContain(`reloc-dump-engine-key-${GUID}`);
    expect(names).toContain(`reloc-verify-dump-${GUID}`);
    // Each job ran where its Secrets are: mongo beside the root credential, the four app-Secret crypto
    // values in the auth member, the bucket AND the engine key in the app member — the engine is the
    // one that holds both the bucket-scoped key and the trusted-service key.
    const byName = new Map(f.source.reader.jobs.map((j) => [j.spec.name, j.namespace]));
    expect(byName.get(`reloc-dump-mongo-${GUID}`)).toBe("mongodb");
    expect(byName.get(`reloc-dump-crypto-${GUID}`)).toBe(`${GUID}-auth-prod`);
    expect(byName.get(`reloc-dump-bucket-${GUID}`)).toBe(`${GUID}-web-prod`);
    expect(byName.get(`reloc-dump-engine-key-${GUID}`)).toBe(`${GUID}-web-prod`);
    // All five properties land under the SAME vault/ folder of the generation, so a hand recovery finds
    // the tenant's whole identity in one place rather than four files in one folder and a fifth elsewhere.
    const [g] = listBackups(db.db, { kind: "tenant", unit: GUID, stage: "prod" });
    expect(g?.folder).toBe(`${INSTALLATION}/prod/tenants/${GUID}/${g?.generation}`);
    const engineKeyJob = f.source.reader.jobs.find((j) => j.spec.name === `reloc-dump-engine-key-${GUID}`);
    expect(engineKeyJob?.spec.script).toContain(`box:${g?.folder}/vault/engine-api-key`);
    expect(engineKeyJob?.spec.env?.some((e) => e.secretKeyRef?.name === "hostyour-engine-api-key")).toBe(true);
  });

  it("verify-dump fails LOUD when the generation is incomplete, and an abort deletes that generation", async () => {
    seedMaster(db);
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    f.source.reader.setJobResult(`reloc-verify-dump-${GUID}`, { succeeded: false, logs: "MISSING vault" });

    const def = makeTenantBackupDef(ports);
    await expect(driveSteps(db, f, def.steps({ tenantId: "tnt_1" }), { tenantId: "tnt_1" }, [])).rejects.toThrow(/MISSING vault/);
    // The registration is still quiesced — the run stopped before open-access, and a retry resumes.
    expect((await ports.registrations.readTenant("prod", GUID))?.entry.quiesced).toBe(true);
    // The unverified generation is no backup: nothing may restore it.
    const unit = { kind: "tenant" as const, unit: GUID, stage: "prod" as const };
    expect(listBackups(db.db, unit).map((b) => b.state)).toEqual(["taking"]);
    // The abort's inverse deletes it from the box and marks it failed.
    const [discard] = def.cleanups!({ tenantId: "tnt_1" });
    await discard!.run(stepCtx(db, discard!.name, { tenantId: "tnt_1" }, []));
    const purge = f.source.reader.jobs.find((j) => j.spec.name === `reloc-purge-generation-${GUID}`);
    expect(purge?.spec.script).toContain(`rclone purge "box:${listBackups(db.db, unit)[0]!.folder}"`);
    expect(listBackups(db.db, unit).map((b) => b.state)).toEqual(["failed"]);
  });
});

describe("backup of a consumer with its own MongoDB", () => {
  const workload = (kind: string, name: string, desired: number) => ({ kind, name, available: true, desired, ready: desired });

  // A quiesced consumer whose manifest brings its own MongoDB: the instance keeps running, which is
  // what keeps its databases reachable for the dump, and its claim holds the live data directory
  // beside the application's own claim, each mounted as its own user.
  async function backUp(mongodb: "standalone" | "shared", application: ReturnType<typeof workload>[]) {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations, { mongodb });
    f.source.reader.setSmoke({ namespaceExists: true, externalSecretsReady: true, workloads: [workload("StatefulSet", "mongodb", 1), ...application] });
    f.source.reader.setClaims(`${CONSUMER}-prod`, ["data-mongodb-0", "uploads"], [{ claim: "data-mongodb", ordinals: true, user: 999, group: 999 }, { claim: "uploads", ordinals: false, user: 1000, group: 1000 }]);
    await driveSteps(db, f, makeBackupDef(ports).steps({ appId: "app_1" }), { appId: "app_1" }, []);
    return (name: string) => f.source.reader.jobs.find((j) => j.spec.name === `reloc-${name}-${CONSUMER}`);
  }

  it("dumps the own instance in the consumer's namespace and leaves its live data directory out of the claim tar", async () => {
    const job = await backUp("standalone", [workload("Deployment", "web", 0)]);
    expect(job("dump-mongo")?.namespace).toBe(`${CONSUMER}-prod`);
    expect(job("dump-mongo")?.spec.env).toContainEqual({ name: "MONGO_HOST", value: "mongodb" });
    expect(job("dump-mongo")?.spec.env).toContainEqual({ name: "MONGO_ROOT_PASSWORD", secretKeyRef: { name: "mongodb-credentials", key: "root-password" } });
    expect(job("dump-pvc")?.spec.pvcMounts?.map((m) => m.claimName)).toEqual(["uploads"]);
    expect(job("dump-pvc")?.spec.runAs).toEqual({ user: 1000, group: 1000 });
  });

  it("still refuses an application workload that runs beside the own MongoDB, and names only that one", async () => {
    await expect(backUp("standalone", [workload("Deployment", "web", 1)])).rejects.toThrow(/still runs Deployment\/web \(1\/1\)$/);
  });

  it("THE INNOCENT NEIGHBOUR: a consumer on the shared set whose own chart runs a StatefulSet mongodb is refused", async () => {
    await expect(backUp("shared", [])).rejects.toThrow("still runs StatefulSet/mongodb (1/1)");
  });
});
