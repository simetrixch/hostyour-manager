import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../../db/client.ts";
import { tenants, clusters } from "../../db/schema/inventory.ts";
import type { Stage } from "../../../shared/enums.ts";
import { makeTenantMigrateDef, TenantMigrateRequest } from "./migrate.run.ts";
import { tenantMoveCleanupWorld } from "./tenant-migrate-stage.ts";
import {
  openFixtureDb, seedMaster, seedClusters, seedTenantRows, tenantEntry, makeFakes,
  tenantPorts, driveSteps, stepCtx, GUID, SUBDOMAIN, SOURCE, TARGET,
} from "./relocation.fixture.ts";

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); seedMaster(db); seedClusters(db); seedTenantRows(db); });
afterEach(() => { db.sqlite.close(); });
const move = { tenantId: "tnt_1", stage: "prod" as const, sourceClusterId: SOURCE.clusterId, targetClusterId: TARGET.clusterId };

function sibling(stage: Stage, clusterId: string = SOURCE.clusterId): void {
  db.db.insert(tenants).values({ id: "tnt_sibling", guid: GUID, subdomain: SUBDOMAIN, clusterId,
    stage, members: ["auth", "jobs", "report"], identityProvider: "auth", status: "active" }).run();
}

describe("one-stage tenant Move", () => {
  it.each(["prod", "dev"] as const)("allows %s to share a target with a sibling DEV/PROD stage without moving the sibling", async (stage) => {
    const other: Stage = stage === "prod" ? "dev" : "prod";
    db.db.update(tenants).set({ stage }).where(eq(tenants.id, move.tenantId)).run(); sibling(other, TARGET.clusterId);
    const before = db.db.select().from(tenants).where(eq(tenants.id, "tnt_sibling")).get();
    const plan = await makeTenantMigrateDef(tenantPorts(makeFakes())).plan({ ...move, stage }, { db: db.db });
    expect(plan.steps).toHaveLength(16);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_sibling")).get()).toEqual(before);
  });

  it("keeps stored legacy runs recoverable, while refusing legacy-shaped new plans and half-specified bindings", async () => {
    const ports = tenantPorts(makeFakes()); const def = makeTenantMigrateDef(ports);
    const legacy = { tenantId: move.tenantId, targetClusterId: move.targetClusterId };
    expect(def.paramsSchema.safeParse(legacy).success).toBe(true);
    expect(TenantMigrateRequest.safeParse(legacy).success).toBe(false);
    expect(def.paramsSchema.safeParse({ ...legacy, stage: "prod" }).success).toBe(false);
    await expect(def.plan(legacy, { db: db.db })).rejects.toThrow(/selected stage and source/);
    await ports.registrations.commitTenant({ stage: "prod", guid: GUID, registration: tenantEntry(), runId: "run_seed" });
    const close = def.steps(legacy).find((s) => s.name === "quiesce")!;
    await close.run(stepCtx(db, close.name, legacy, []));
    expect((await ports.registrations.readTenant("prod", GUID))?.entry.quiesced).toBe(true);
    // A legacy run that resumes still closes the unit, so its abort must resolve the reopen the quiesce arms.
    expect(def.cleanups?.(legacy).map((c) => c.name)).toEqual(["discard-generation", "reopen-access"]);
  });

  it("replays record after its own inventory commit, but refuses a different run or earlier step", async () => {
    const ports = tenantPorts(makeFakes()); const def = makeTenantMigrateDef(ports);
    await ports.registrations.commitTenant({ stage: "prod", guid: GUID, registration: tenantEntry({ cluster: TARGET.cluster }), runId: "run_reloc" });
    db.db.update(tenants).set({ clusterId: TARGET.clusterId, lastRunId: "run_reloc" }).where(eq(tenants.id, move.tenantId)).run();
    const record = def.steps(move).find((s) => s.name === "record")!;
    await record.run(stepCtx(db, record.name, move, []));
    const close = def.steps(move).find((s) => s.name === "quiesce")!;
    await expect(close.run(stepCtx(db, close.name, move, []))).rejects.toThrow(/source.*changed/i);
    await expect(record.run(stepCtx(db, record.name, move, [], "run_other"))).rejects.toThrow(/source.*changed/i);
  });

  it("retains source/stage safety for abort cleanup without depending on an available target", async () => {
    const ports = tenantPorts(makeFakes());
    await ports.registrations.commitTenant({ stage: "prod", guid: GUID, registration: tenantEntry(), runId: "run_seed" });
    db.db.update(clusters).set({ status: "removed" }).where(eq(clusters.id, TARGET.clusterId)).run();
    const world = tenantMoveCleanupWorld(ports, move);
    const cleanup = makeTenantMigrateDef(ports).cleanups!(move)[0]!;
    const logs: string[] = [];
    await cleanup.run(stepCtx(db, cleanup.name, move, logs));
    expect(logs.some((line) => line.includes("nothing to delete"))).toBe(true);
    expect((await world(stepCtx(db, "discard-generation", move, []))).sourceClusterId).toBe(SOURCE.clusterId);
    db.db.update(tenants).set({ stage: "test" }).where(eq(tenants.id, move.tenantId)).run();
    await expect(world(stepCtx(db, "discard-generation", move, []))).rejects.toThrow(/stage.*changed/i);
    await expect(cleanup.run(stepCtx(db, cleanup.name, move, []))).rejects.toThrow(/stage.*changed/i);
  });

  it("refuses stale stage/source at plan time and names the stage/source/target in its sixteen-step plan", async () => {
    const def = makeTenantMigrateDef(tenantPorts(makeFakes()));
    await expect(def.plan({ ...move, stage: "test" }, { db: db.db })).rejects.toThrow(/stage.*changed/i);
    await expect(def.plan({ ...move, sourceClusterId: TARGET.clusterId }, { db: db.db })).rejects.toThrow(/source.*changed/i);
    const plan = await def.plan(move, { db: db.db });
    expect(plan.summary).toContain("prod"); expect(plan.summary).toContain(SOURCE.domain); expect(plan.summary).toContain(TARGET.domain);
    expect(plan.steps).toHaveLength(16);
  });

  it("rechecks stage/source and target-stage drift before any execution write", async () => {
    const f = makeFakes(); const def = makeTenantMigrateDef(tenantPorts(f));
    await def.plan(move, { db: db.db });
    const first = def.steps(move)[0]!;
    db.db.update(tenants).set({ stage: "test" }).where(eq(tenants.id, move.tenantId)).run();
    await expect(first.run(stepCtx(db, first.name, move, []))).rejects.toThrow(/stage.*changed/i);
    db.db.update(tenants).set({ stage: "prod", clusterId: TARGET.clusterId }).where(eq(tenants.id, move.tenantId)).run();
    await expect(first.run(stepCtx(db, first.name, move, []))).rejects.toThrow(/source.*changed/i);
    db.db.update(tenants).set({ clusterId: SOURCE.clusterId }).where(eq(tenants.id, move.tenantId)).run();
    sibling("test", TARGET.clusterId);
    await expect(first.run(stepCtx(db, first.name, move, []))).rejects.toThrow(/another stage/i);
    expect(f.source.reader.jobs).toEqual([]); expect(f.target.reader.jobs).toEqual([]);
    expect(f.source.reader.deletedNamespaces).toEqual([]);
  });

  it("rechecks after completed attestation instead of moving a newly suspended or different stage on retry", async () => {
    const f = makeFakes(); const ports = tenantPorts(f); const def = makeTenantMigrateDef(ports);
    await ports.registrations.commitTenant({ stage: "prod", guid: GUID, registration: tenantEntry(), runId: "run_seed" });
    const steps = def.steps(move); await steps[0]!.run(stepCtx(db, steps[0]!.name, move, []));
    db.db.update(tenants).set({ suspended: true }).where(eq(tenants.id, move.tenantId)).run();
    await expect(def.plan(move, { db: db.db })).rejects.toThrow(/active.*unsuspended/i);
    const close = steps.find((s) => s.name === "quiesce")!;
    await expect(close.run(stepCtx(db, close.name, move, []))).rejects.toThrow(/active.*unsuspended/i);
    expect((await ports.registrations.readTenant("prod", GUID))?.entry.quiesced).toBe(false);
    db.db.update(tenants).set({ suspended: false, stage: "test" }).where(eq(tenants.id, move.tenantId)).run();
    await expect(close.run(stepCtx(db, close.name, move, []))).rejects.toThrow(/stage.*changed/i);
  });

  it("attests target and source before closing access", async () => {
    const f = makeFakes(); const ports = tenantPorts(f);
    const resolve = ports.resolver.resolve.bind(ports.resolver);
    ports.resolver = { resolve: async (id) => {
      const side = await resolve(id);
      if (id === TARGET.clusterId) side.clusterReader.readDeployState = async () => null;
      return side;
    } };
    const first = makeTenantMigrateDef(ports).steps(move)[0]!;
    await expect(first.run(stepCtx(db, first.name, move, []))).rejects.toThrow(/deploy-state/);
    expect(f.source.reader.jobs).toEqual([]); expect(f.target.reader.jobs).toEqual([]);
  });

  it.each(["prod", "test"] as const)("moves every member of %s while preserving the sibling stage", async (stage) => {
    const other: Stage = stage === "prod" ? "test" : "prod";
    db.db.update(tenants).set({ stage }).where(eq(tenants.id, move.tenantId)).run(); sibling(other);
    const beforeRow = db.db.select().from(tenants).where(eq(tenants.id, "tnt_sibling")).get();
    const f = makeFakes(); const ports = tenantPorts(f);
    await ports.registrations.commitTenant({ stage, guid: GUID, registration: tenantEntry(), runId: "run_seed" });
    await ports.registrations.commitTenant({ stage: other, guid: GUID, registration: tenantEntry(), runId: "run_other" });
    const beforePointer = await ports.registrations.readTenant(other, GUID);
    const otherRecord = `*.${SUBDOMAIN}.${other === "prod" ? "" : `${other}.`}example.com`;
    f.dns.seed(otherRecord, "CNAME", SOURCE.domain);
    const otherNamespace = `${GUID}-auth-${other}`;
    f.source.reader.namespaceAnnotations.set(otherNamespace, { keep: "sibling" });
    f.source.reader.setJobResult(`reloc-list-source-${GUID}`, { succeeded: true, logs: `DB ${GUID}_auth_${stage}\nDB ${GUID}_web_${stage}` });
    f.target.reader.setSecretValue(`${GUID}-auth-${stage}`, "hostyour-app-secrets", "AUTH_JWT_PUBLIC_KEY", "public-fixture");
    const names = ["auth", "jobs", "report", "web"].map((m) => `${GUID}-${m}-${stage}`);
    const rendered = (quiesced: boolean) => new Map(names.map((name) => [name, {
      syncRevision: null, targetRevision: null, sync: "Synced" as const, health: "Healthy" as const,
      syncSources: [{ repoURL: ports.deployRepoUrl, revision: "abc", path: "charts/example-engine", valuesObject: { tenant: { quiesced } } }],
    }]));
    const params = { ...move, stage };
    await driveSteps(db, f, makeTenantMigrateDef(ports).steps(params), params, [], {
      "verify-quiesced": () => f.source.argo.setStatuses(rendered(true)),
      "watch": () => f.target.argo.setStatuses(rendered(true)),
      "verify-source-released": () => f.source.argo.setStatuses(new Map()),
      "open-access": () => f.target.argo.setStatuses(rendered(false)),
    });
    expect((await ports.registrations.readTenant(stage, GUID))?.entry.cluster).toBe(TARGET.cluster);
    expect(await ports.registrations.readTenant(other, GUID)).toEqual(beforePointer);
    expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_sibling")).get()).toEqual(beforeRow);
    expect(f.dns.record(otherRecord, "CNAME")).toBe(SOURCE.domain);
    expect(f.source.reader.namespaceAnnotations.get(otherNamespace)).toEqual({ keep: "sibling" });
    expect(f.source.reader.deletedNamespaces).not.toContain(otherNamespace);
    expect(f.source.reader.deletedNamespaces).toEqual(expect.arrayContaining(names));
    for (const name of names) expect(f.target.projects.get(TARGET.cluster, name)).toBeDefined();
    const scripts = [...f.source.reader.jobs, ...f.target.reader.jobs].map((j) => j.spec.script).join("\n");
    expect(scripts).toContain(`^${GUID}_.*_${stage}$`); expect(scripts).not.toContain(`^${GUID}_.*_${other}$`);
    // This planted all-stage mutation must be caught inside the passing run.
    const preserved = () => expect(db.db.select().from(tenants).where(eq(tenants.id, "tnt_sibling")).get()).toEqual(beforeRow);
    preserved(); db.db.update(tenants).set({ clusterId: TARGET.clusterId }).where(eq(tenants.guid, GUID)).run();
    expect(preserved).toThrow();
  });
});
