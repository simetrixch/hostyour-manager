import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import type { Cleanup, Step } from "../../executor/types.ts";
import {
  openFixtureDb, seedClusters, seedMaster, seedConsumerRow, seedTenantRows, seedConsumerRegistration, seedTenantWorld,
  makeFakes, consumerPorts, tenantPorts, renderRelocation, stepCtx, GUID, CONSUMER, SOURCE, TARGET,
} from "./relocation.fixture.ts";
import { makeBackupDef, makeTenantBackupDef } from "./backup.run.ts";
import { makeMigrateDef, makeTenantMigrateDef } from "./migrate.run.ts";
import { tenantWorld } from "./relocation-world-tenant.ts";
import { quiesceStep, type RelocationWorld } from "#unit/server/relocation.ts";

let db: DbHandle;
beforeEach(() => {
  db = openFixtureDb();
  seedMaster(db);
  seedClusters(db);
  seedConsumerRow(db);
});
afterEach(() => {
  db.sqlite.close();
});

type Fakes = ReturnType<typeof makeFakes>;
const params = { appId: "app_1" };
const move = { appId: "app_1", targetClusterId: TARGET.clusterId };

/** Runs the steps in order, as the executor does, until one fails or `last` has run, keeping what they
 *  arm. The source renders the quiesced state once access is closed. */
async function runSteps(f: Fakes, steps: Step[], p: Readonly<Record<string, unknown>>, logs: string[], last?: string) {
  const armed: Cleanup[] = [];
  for (const step of steps) {
    if (step.name === "verify-quiesced") renderRelocation(f.source, true);
    try {
      await step.run({ ...stepCtx(db, step.name, p, logs), registerCleanup: (c: Cleanup) => { armed.push(c); } });
    } catch {
      return { armed, failedAt: step.name };
    }
    if (step.name === last) break;
  }
  return { armed, failedAt: null };
}

/** What Abort (cleanup) does: resolve each armed name through the definition and run them reversed. */
async function abort(defCleanups: Cleanup[], armed: readonly Cleanup[], p: Readonly<Record<string, unknown>>, logs: string[]): Promise<void> {
  const byName = new Map(defCleanups.map((c) => [c.name, c]));
  for (const { name } of [...armed].reverse()) {
    const cleanup = byName.get(name);
    if (!cleanup) throw new Error(`the definition cannot resolve the armed cleanup ${name}`);
    await cleanup.run(stepCtx(db, name, p, logs));
  }
}

/** A backup whose source still answers fails at verify-quiesced, after the quiesce. */
const answering = (f: Fakes, url: string) => f.probe.set(url, { reachable: true, status: 200, detail: "HTTP 200" });

describe("reopen-access compensation", () => {
  // Planted defect: without the registerCleanup in quiesceStep, nothing reopens the unit.
  it("reopens a consumer whose backup failed after the quiesce", async () => {
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    answering(f, `https://${CONSUMER}.${SOURCE.domain}/`);
    const def = makeBackupDef(ports);
    const logs: string[] = [];

    const { armed, failedAt } = await runSteps(f, def.steps(params), params, logs);
    expect(failedAt).toBe("verify-quiesced");
    expect((await ports.registrations.readRegistration("prod", CONSUMER))?.entry.quiesced).toBe(true);

    renderRelocation(f.source, false);
    await abort(def.cleanups!(params), armed, params, logs);
    expect((await ports.registrations.readRegistration("prod", CONSUMER))?.entry.quiesced).toBe(false);
    expect(logs.some((l) => l.includes("reopened"))).toBe(true);
  });

  // Planted defect: arming after the flip leaves a unit closed where the run stops while the flip lands.
  it("arms the reopen before the flip, so a failed flip still has it, and it finds the unit open", async () => {
    let flips = 0;
    const world = {
      kindWord: "consumer", unit: CONSUMER, sourceCluster: SOURCE.cluster, sourceClusterId: SOURCE.clusterId,
      readStanding: async () => ({ quiesced: false, cluster: SOURCE.cluster }),
      setQuiesced: async () => { flips++; throw new Error("the books branch refused the commit"); },
    } as unknown as RelocationWorld;
    const armed: Cleanup[] = [];
    const logs: string[] = [];
    await expect(quiesceStep(async () => world).run({ ...stepCtx(db, "quiesce", params, logs), registerCleanup: (c: Cleanup) => { armed.push(c); } }))
      .rejects.toThrow("refused the commit");
    expect(armed.map((c) => c.name)).toEqual(["reopen-access"]);

    await armed[0]!.run(stepCtx(db, "reopen-access", params, logs));
    expect(flips).toBe(1);
    expect(logs.some((l) => l.includes("is open already"))).toBe(true);
  });

  // Planted defect: arming the reopen unconditionally opens a unit an operator had closed.
  it("leaves a unit closed that was closed before the backup", async () => {
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations, { quiesced: true });
    answering(f, `https://${CONSUMER}.${SOURCE.domain}/`);
    const def = makeBackupDef(ports);
    const logs: string[] = [];

    const { armed, failedAt } = await runSteps(f, def.steps(params), params, logs);
    expect(failedAt).toBe("verify-quiesced");
    expect(armed.map((c) => c.name)).not.toContain("reopen-access");

    await abort(def.cleanups!(params), armed, params, logs);
    expect((await ports.registrations.readRegistration("prod", CONSUMER))?.entry.quiesced).toBe(true);
  });

  // Planted defect: without the cluster check, an abort after the repoint serves the target's incomplete copy.
  it("leaves a move closed when it is aborted after its repoint", async () => {
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    const def = makeMigrateDef(ports);
    const logs: string[] = [];

    const { armed, failedAt } = await runSteps(f, def.steps(move), move, logs, "repoint");
    expect(failedAt).toBeNull();
    expect((await ports.registrations.readRegistration("prod", CONSUMER))?.entry.cluster).toBe(TARGET.cluster);

    await abort(def.cleanups!(move), armed, move, logs);
    expect((await ports.registrations.readRegistration("prod", CONSUMER))?.entry.quiesced).toBe(true);
    expect(logs.some((l) => l.includes("stays closed"))).toBe(true);
  });

  it("reopens a move aborted before its repoint", async () => {
    const f = makeFakes();
    const ports = consumerPorts(f);
    await seedConsumerRegistration(ports.registrations);
    const def = makeMigrateDef(ports);
    const logs: string[] = [];

    const { armed, failedAt } = await runSteps(f, def.steps(move), move, logs, "dump");
    expect(failedAt).toBeNull();

    renderRelocation(f.source, false);
    await abort(def.cleanups!(move), armed, move, logs);
    expect((await ports.registrations.readRegistration("prod", CONSUMER))?.entry.quiesced).toBe(false);
  });

  it("reopens a tenant whose backup failed after the quiesce", async () => {
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    const tenant = { tenantId: "tnt_1" };
    const w = await tenantWorld(ports, "tnt_1")(stepCtx(db, "probe", tenant, []));
    answering(f, `${w.publicUrl}/`);
    const def = makeTenantBackupDef(ports);
    const logs: string[] = [];

    const { armed, failedAt } = await runSteps(f, def.steps(tenant), tenant, logs);
    expect(failedAt).toBe("verify-quiesced");
    expect((await ports.registrations.readTenant("prod", GUID))?.entry.quiesced).toBe(true);

    renderRelocation(f.source, false);
    await abort(def.cleanups!(tenant), armed, tenant, logs);
    expect((await ports.registrations.readTenant("prod", GUID))?.entry.quiesced).toBe(false);
  });

  // Planted defect: a definition that runs quiesceStep without resolving reopen-access cannot be aborted.
  it("resolves reopen-access in every definition that runs quiesceStep", () => {
    const f = makeFakes();
    const tenantMove = { tenantId: "tnt_1", targetClusterId: TARGET.clusterId, stage: "prod", sourceClusterId: SOURCE.clusterId };
    const lists = [
      makeBackupDef(consumerPorts(f)).cleanups!(params),
      makeTenantBackupDef(tenantPorts(f)).cleanups!({ tenantId: "tnt_1" }),
      makeMigrateDef(consumerPorts(f)).cleanups!(move),
      makeTenantMigrateDef(tenantPorts(f)).cleanups!(tenantMove as Parameters<NonNullable<ReturnType<typeof makeTenantMigrateDef>["cleanups"]>>[0]),
    ];
    for (const list of lists) expect(list.map((c) => c.name)).toContain("reopen-access");
  });
});
