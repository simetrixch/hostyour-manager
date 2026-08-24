import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../../db/client.ts";
import { apps, tenants } from "../../db/schema/inventory.ts";
import { makeBackupDef, makeTenantBackupDef } from "./backup.run.ts";
import { FAKE_BOOKS_BRANCH } from "../../adapters/git/testing/fake.ts";
import {
  openFixtureDb, seedClusters, seedConsumerRow, seedTenantRows, seedConsumerRegistration, seedTenantWorld,
  makeFakes, consumerPorts, tenantPorts, driveSteps, jobNames, GUID, CONSUMER, SOURCE,
} from "./relocation.fixture.ts";

// backup / tenant-backup — the first half of the ONE relocation mechanism, run for its own sake. The
// journey both defs must satisfy: a backup LEAVES THE UNIT RUNNING — access is closed and
// measured closed only for the dump, then reopened, the folder stays, and nothing of the unit's
// state (row, registration, cluster objects) is any different afterwards.

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

  it("journey: a backup leaves the unit running — quiesce is flipped back, the row is untouched, and the dump jobs filled the folder", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);

    const logs: string[] = [];
    await driveSteps(db, makeBackupDef(ports).steps({ appId: "app_1" }), { appId: "app_1" }, logs);

    // The registration ends OPEN — quiesced held only for the dump.
    expect((await ports.registrations.readRegistration("prod", CONSUMER))?.entry.quiesced).toBe(false);
    // The row is untouched: a backup changes nothing about where or whether the unit runs.
    expect(db.db.select().from(apps).where(eq(apps.id, "app_1")).get()?.status).toBe("active");
    // Access was MEASURED closed on the unit's public host, never assumed.
    expect(f.probe.probed).toEqual([`https://${CONSUMER}.${SOURCE.domain}/`]);
    // The dump ran where the stores are (the registration copy in the unit ns, mongo in the platform
    // ns) and the folder was verified; nothing cleared anything.
    const names = jobNames(f.source);
    expect(names).toContain(`reloc-dump-reg-${CONSUMER}`);
    expect(names).toContain(`reloc-dump-mongo-${CONSUMER}`);
    expect(names).toContain(`reloc-verify-dump-${CONSUMER}`);
    expect(names.find((n) => n.startsWith("reloc-clear-source"))).toBeUndefined();
    expect(jobNames(f.target)).toEqual([]);
  });

  it("verify-quiesced fails LOUD when the public address still answers — a chart that ignored the flag", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    f.probe.set(`https://${CONSUMER}.${SOURCE.domain}/`, { reachable: true, detail: "HTTP 200" });

    const steps = makeBackupDef(ports).steps({ appId: "app_1" });
    await expect(driveSteps(db, steps, { appId: "app_1" }, [])).rejects.toThrow(/still answers/);
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
    await expect(driveSteps(db, makeBackupDef(ports).steps({ appId: "app_1" }), { appId: "app_1" }, [])).rejects.toThrow(/storage-box/);
  });
});

describe("tenant-backup", () => {
  it("journey: a backup leaves the tenant running, and the dump covers every store of the bracket", async () => {
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);

    const def = makeTenantBackupDef(ports);
    const plan = await def.plan({ tenantId: "tnt_1" }, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(STEP_ORDER);

    const logs: string[] = [];
    await driveSteps(db, def.steps({ tenantId: "tnt_1" }), { tenantId: "tnt_1" }, logs);

    expect((await ports.registrations.readTenant("prod", GUID))?.entry.quiesced).toBe(false);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_1")).get()?.status).toBe("active");
    // The complete data scope: every <guid>_* database, the crypto material, and — the tenant has an
    // app, so a bucket exists — the object storage, then the folder verification.
    const names = jobNames(f.source);
    expect(names).toContain(`reloc-dump-mongo-${GUID}`);
    expect(names).toContain(`reloc-dump-crypto-${GUID}`);
    expect(names).toContain(`reloc-dump-bucket-${GUID}`);
    // The fifth crypto property. Its own job because it is in its own Secret in its own namespace —
    // the kit renders example-engine-api-key only where it is read, which is not the IdP member.
    expect(names).toContain(`reloc-dump-engine-key-${GUID}`);
    expect(names).toContain(`reloc-verify-dump-${GUID}`);
    // Each job ran where its Secrets are: mongo beside the root credential, the four app-Secret crypto
    // values in the auth member, the bucket AND the engine key in the app member — the engine is the
    // one that holds both the bucket-scoped key and the trusted-service key.
    const byName = new Map(f.source.reader.jobs.map((j) => [j.spec.name, j.namespace]));
    expect(byName.get(`reloc-dump-mongo-${GUID}`)).toBe("mongodb");
    expect(byName.get(`reloc-dump-crypto-${GUID}`)).toBe(`${GUID}-auth`);
    expect(byName.get(`reloc-dump-bucket-${GUID}`)).toBe(`${GUID}-web`);
    expect(byName.get(`reloc-dump-engine-key-${GUID}`)).toBe(`${GUID}-web`);
    // All five properties land under the SAME vault/ folder, so a hand recovery finds the tenant's
    // whole identity in one place rather than four files in one folder and a fifth somewhere else.
    const engineKeyJob = f.source.reader.jobs.find((j) => j.spec.name === `reloc-dump-engine-key-${GUID}`);
    expect(engineKeyJob?.spec.script).toContain(`box:${GUID}/vault/engine-api-key`);
    expect(engineKeyJob?.spec.env?.some((e) => e.secretKeyRef?.name === "example-engine-api-key")).toBe(true);
  });

  it("verify-dump fails LOUD when the folder is incomplete", async () => {
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    f.source.reader.setJobResult(`reloc-verify-dump-${GUID}`, { succeeded: false, logs: "MISSING vault" });

    await expect(driveSteps(db, makeTenantBackupDef(ports).steps({ tenantId: "tnt_1" }), { tenantId: "tnt_1" }, [])).rejects.toThrow(/MISSING vault/);
    // The registration is still quiesced — the run stopped before open-access, and a retry resumes.
    expect((await ports.registrations.readTenant("prod", GUID))?.entry.quiesced).toBe(true);
  });
});
