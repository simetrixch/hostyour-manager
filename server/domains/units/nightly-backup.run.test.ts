import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Cleanup } from "../../executor/types.ts";
import type { DbHandle } from "../../db/client.ts";
import { apps } from "../../db/schema/inventory.ts";
import { listBackups, recordBackupFinished, recordBackupStarted } from "../../db/unit-backups.ts";
import { makeConsumerNightlyBackupDef, makeTenantNightlyBackupDef } from "./nightly-backup.run.ts";
import {
  openFixtureDb, seedClusters, seedMaster, seedConsumerRow, seedConsumerRegistration, seedTenantRows, seedTenantWorld,
  makeFakes, consumerPorts, tenantPorts, driveSteps, jobNames, stepCtx, CONSUMER, GUID, INSTALLATION, SOURCE,
} from "./relocation.fixture.ts";

// The nightly pass of hostyour-cloud#254: every standing unit backed up online into a new generation,
// retention after it, and one unit's failure recorded without stopping the next one.

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); });
afterEach(() => { db.sqlite.close(); });

const consumer = { kind: "consumer" as const, unit: CONSUMER, stage: "prod" as const };

/** Verified generations of the consumer from earlier nights, as the book would hold them. */
function seedEarlierNights(dates: readonly string[]): void {
  for (const d of dates) {
    const g = { ...consumer, generation: `${d}T030000Z` };
    recordBackupStarted(db.db, { ...g, folder: `${INSTALLATION}/prod/consumers/${CONSUMER}/${g.generation}`, trigger: "nightly", runId: `run_${d}` });
    recordBackupFinished(db.db, g, { state: "ok" });
  }
}

describe("consumer-nightly-backup", () => {
  it("plans one step over every standing consumer under the master lock, and refuses a manager without a Storage Box", async () => {
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const plan = await makeConsumerNightlyBackupDef(consumerPorts(f)).plan({}, { db: db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(["back-up-every-consumer"]);
    expect(plan.locks).toEqual([{ resource: "master-kube", key: "m" }]);
    expect(plan.summary).toMatch(/^Back up 1 standing consumer\(s\) online — access stays open/);
    const unwired = { ...consumerPorts(f) };
    delete (unwired as { storageBox?: unknown }).storageBox;
    await expect(makeConsumerNightlyBackupDef(unwired).plan({}, { db: db.db })).rejects.toThrow(/requires the Hetzner Storage Box/);
  });

  it("journey: backs a consumer up online without closing access, and retention drops what the rule does not keep", async () => {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    // Nine earlier nights, 2026-09-10 to 2026-09-18: with tonight's the newest seven reach back to
    // 2026-09-13, and the newest of the week of Monday 2026-09-07 is 2026-09-13 too.
    seedEarlierNights(["20260910", "20260911", "20260912", "20260913", "20260914", "20260915", "20260916", "20260917", "20260918"]);

    const def = makeConsumerNightlyBackupDef(ports);
    await driveSteps(db, f, def.steps({}), {}, []);

    // Access was never closed: no quiesce commit, no probe of the public address.
    expect((await ports.registrations.readRegistration("prod", CONSUMER))?.entry.quiesced).toBe(false);
    expect(f.probe.probed).toEqual([]);
    const book = listBackups(db.db, consumer);
    const tonight = book[0]!;
    expect(tonight).toMatchObject({ trigger: "nightly", state: "ok", runId: "run_reloc" });
    expect(jobNames(f.source)).toEqual(expect.arrayContaining([`reloc-dump-mongo-${CONSUMER}`, `reloc-manifest-${CONSUMER}`, `reloc-verify-dump-${CONSUMER}`]));
    // Retention took the three oldest off the box and marked them in the book.
    expect(book.filter((b) => b.state === "pruned").map((b) => b.generation).sort()).toEqual(["20260910T030000Z", "20260911T030000Z", "20260912T030000Z"]);
    const purged = f.source.reader.jobs.filter((j) => j.spec.name === `reloc-purge-generation-${CONSUMER}`).map((j) => j.spec.script);
    expect(purged).toHaveLength(3);
    expect(purged[0]).toContain(`${INSTALLATION}/prod/consumers/${CONSUMER}/2026091`);
  });

  it("dumps a consumer's own MongoDB from the instance in its namespace, not from the shared set", async () => {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations, { mongodb: "standalone" });
    await driveSteps(db, f, makeConsumerNightlyBackupDef(ports).steps({}), {}, []);
    const dump = f.source.reader.jobs.find((j) => j.spec.name === `reloc-dump-mongo-${CONSUMER}`);
    expect(dump?.namespace).toBe(`${CONSUMER}-prod`);
    expect(dump?.spec.env).toContainEqual({ name: "MONGO_HOST", value: "mongodb" });
    expect(listBackups(db.db, consumer)[0]).toMatchObject({ trigger: "nightly", state: "ok" });
  });

  it("records a consumer that fails, backs up the next one anyway, and fails the run naming only the one", async () => {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    // A second standing consumer whose registration is gone: its dump cannot even read what it is.
    db.db.insert(apps).values({ id: "app_2", clusterId: SOURCE.clusterId, name: "ghost", stage: "prod", host: "ghost", repoUrl: "https://github.com/x/ghost.git", chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);

    await expect(driveSteps(db, f, makeConsumerNightlyBackupDef(ports).steps({}), {}, [])).rejects.toThrow(/^1 of 2 consumer\(s\) failed the nightly backup: consumer ghost \(prod\) \(consumer "ghost" is not registered at prod/);
    expect(listBackups(db.db, consumer).map((b) => b.state)).toEqual(["ok"]);
    const ghost = listBackups(db.db, { ...consumer, unit: "ghost" });
    expect(ghost.map((b) => [b.trigger, b.state])).toEqual([["nightly", "failed"]]);
    expect(ghost[0]!.detail).toMatch(/not registered at prod/);
    // The failed generation was taken off the box again, before the failure was reported.
    expect(jobNames(f.source)).toContain("reloc-purge-generation-ghost");
  });
});

describe("a nightly run whose Manager died mid-dump", () => {
  /** The pass over acme and a second consumer, ghost, whose world resolves as the dump's does. */
  function twoConsumers(): { ports: ReturnType<typeof consumerPorts>; f: ReturnType<typeof makeFakes> } {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    db.db.insert(apps).values({ id: "app_2", clusterId: SOURCE.clusterId, name: "ghost", stage: "prod", host: "ghost", repoUrl: "https://github.com/x/ghost.git", chartPath: "deploy/chart", provenance: "manager", status: "active" }).run();
    const f = makeFakes();
    return { ports: consumerPorts(f), f };
  }
  /** A generation the dead run opened, as the book holds it after the restart. */
  function opened(unit: string, state: "taking" | "ok"): void {
    const g = { ...consumer, unit, generation: "20261003T030000Z" };
    recordBackupStarted(db.db, { ...g, folder: `${INSTALLATION}/prod/consumers/${unit}/${g.generation}`, trigger: "nightly", runId: "run_reloc" });
    if (state === "ok") recordBackupFinished(db.db, g, { state: "ok" });
  }

  it("arms the discard on the run as it opens a generation, before the dump can die", async () => {
    seedMaster(db);
    seedClusters(db);
    seedConsumerRow(db);
    const ports = consumerPorts(makeFakes());
    await seedConsumerRegistration(ports.registrations);
    const armed: string[] = [];
    const [step] = makeConsumerNightlyBackupDef(ports).steps({});
    await step!.run({ ...stepCtx(db, step!.name, {}, []), registerCleanup: (c: Cleanup) => armed.push(c.name) });
    expect(armed).toEqual(["discard-generation"]);
    expect(makeConsumerNightlyBackupDef(ports).cleanups!({}).map((c) => c.name)).toEqual(["discard-generation"]);
  });

  it("PLANTED DEFECT: its abort deletes the unfinished generation of every unit, not only the first", async () => {
    const { ports, f } = twoConsumers();
    opened(CONSUMER, "taking");
    opened("ghost", "taking");
    const [discard] = makeConsumerNightlyBackupDef(ports).cleanups!({});
    await discard!.run(stepCtx(db, discard!.name, {}, []));
    expect(listBackups(db.db, consumer).map((b) => b.state)).toEqual(["failed"]);
    expect(listBackups(db.db, { ...consumer, unit: "ghost" }).map((b) => b.state)).toEqual(["failed"]);
    expect(jobNames(f.source)).toEqual(expect.arrayContaining([`reloc-purge-generation-${CONSUMER}`, "reloc-purge-generation-ghost"]));
  });

  it("PLANTED INNOCENT: its abort leaves a generation the dead run had verified", async () => {
    const { ports, f } = twoConsumers();
    opened(CONSUMER, "ok");
    opened("ghost", "taking");
    const [discard] = makeConsumerNightlyBackupDef(ports).cleanups!({});
    await discard!.run(stepCtx(db, discard!.name, {}, []));
    expect(listBackups(db.db, consumer).map((b) => b.state)).toEqual(["ok"]);
    expect(listBackups(db.db, { ...consumer, unit: "ghost" }).map((b) => b.state)).toEqual(["failed"]);
    expect(jobNames(f.source)).not.toContain(`reloc-purge-generation-${CONSUMER}`);
  });

  it("PLANTED DEFECT: a unit whose discard fails does not keep the next one taking, and the abort fails naming it", async () => {
    const { ports, f } = twoConsumers();
    opened(CONSUMER, "taking");
    opened("ghost", "taking");
    f.source.reader.setJobResult(`reloc-purge-generation-${CONSUMER}`, { succeeded: false, logs: "rm: permission denied" });
    const [discard] = makeConsumerNightlyBackupDef(ports).cleanups!({});
    await expect(discard!.run(stepCtx(db, discard!.name, {}, []))).rejects.toThrow(new RegExp(`^1 unfinished generation\\(s\\) could not be deleted: consumer ${CONSUMER}: job reloc-purge-generation-${CONSUMER}`));
    expect(listBackups(db.db, { ...consumer, unit: "ghost" }).map((b) => b.state)).toEqual(["failed"]);
  });

  it("PLANTED DEFECT: its abort deletes the unfinished generation of a unit offboarded after the dump died", async () => {
    const { ports, f } = twoConsumers();
    opened("ghost", "taking");
    db.db.update(apps).set({ status: "offboarded" }).where(eq(apps.id, "app_2")).run();
    const [discard] = makeConsumerNightlyBackupDef(ports).cleanups!({});
    await discard!.run(stepCtx(db, discard!.name, {}, []));
    expect(listBackups(db.db, { ...consumer, unit: "ghost" }).map((b) => b.state)).toEqual(["failed"]);
    expect(jobNames(f.source)).toContain("reloc-purge-generation-ghost");
  });
});

describe("tenant-nightly-backup", () => {
  it("backs every standing tenant up online, the whole bracket in one generation", async () => {
    seedMaster(db);
    seedClusters(db);
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);

    await driveSteps(db, f, makeTenantNightlyBackupDef(ports).steps({}), {}, []);

    expect((await ports.registrations.readTenant("prod", GUID))?.entry.quiesced).toBe(false);
    const [g] = listBackups(db.db, { kind: "tenant", unit: GUID, stage: "prod" });
    expect(g).toMatchObject({ trigger: "nightly", state: "ok" });
    expect(jobNames(f.source)).toEqual(expect.arrayContaining([`reloc-dump-mongo-${GUID}`, `reloc-dump-crypto-${GUID}`, `reloc-dump-bucket-${GUID}`, `reloc-manifest-${GUID}`]));
  });

  it("PLANTED DEFECT: its abort deletes the unfinished generation of a tenant offboarded after the dump died", async () => {
    seedMaster(db);
    seedClusters(db);
    seedTenantRows(db, "offboarded");
    const f = makeFakes();
    const ports = tenantPorts(f);
    const g = { kind: "tenant" as const, unit: GUID, stage: "prod" as const, generation: "20261003T030000Z" };
    recordBackupStarted(db.db, { ...g, folder: `${INSTALLATION}/prod/tenants/${GUID}/${g.generation}`, trigger: "nightly", runId: "run_reloc" });
    const [discard] = makeTenantNightlyBackupDef(ports).cleanups!({});
    await discard!.run(stepCtx(db, discard!.name, {}, []));
    expect(listBackups(db.db, { kind: "tenant", unit: GUID, stage: "prod" }).map((b) => b.state)).toEqual(["failed"]);
    expect(jobNames(f.source)).toContain(`reloc-purge-generation-${GUID}`);
  });
});
