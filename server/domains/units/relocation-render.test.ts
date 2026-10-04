import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { tenantWorld } from "./relocation-world-tenant.ts";
import { consumerWorld } from "./relocation-world-consumer.ts";
import { syncedAt, describeUnsynced } from "#unit/server/argo-app-status.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import {
  openFixtureDb, seedClusters, seedMaster, seedTenantRows, seedConsumerRow, makeFakes,
  tenantPorts, consumerPorts, seedTenantWorld, seedConsumerRegistration, stepCtx,
  renderRelocation, tenantEntry, GUID, SOURCE, TARGET,
} from "./relocation.fixture.ts";

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); seedMaster(db); seedClusters(db); });
afterEach(() => { db.sqlite.close(); });

function tenantStatus(quiesced: boolean, refreshRequested = false): ArgoAppStatus {
  return { syncRevision: null, targetRevision: null, sync: "Synced", health: "Healthy", refreshRequested,
    syncSources: [{ repoURL: "https://github.com/acme/acme-deploy.git", revision: "a", path: "charts/example-engine", valuesObject: { tenant: { quiesced } } }],
  };
}

describe("relocation waits for the desired render", () => {
  for (const kind of ["tenant", "consumer"] as const) {
    for (const quiesced of [true, false]) {
      it(`${kind}: refuses an old Healthy ${quiesced ? "running" : "quiesced"} render, then accepts the desired render on the explicit cluster`, async () => {
        const f = makeFakes();
        const ctx = stepCtx(db, "watch", {}, []);
        let world;
        if (kind === "tenant") {
          seedTenantRows(db);
          const ports = tenantPorts(f);
          await seedTenantWorld(ports.registrations);
          await ports.registrations.setTenantQuiesced("prod", GUID, quiesced, ctx.runId);
          world = await tenantWorld(ports, "tnt_1")(ctx);
        } else {
          seedConsumerRow(db);
          const ports = consumerPorts(f);
          await seedConsumerRegistration(ports.registrations, { quiesced });
          world = await consumerWorld(ports, "app_1")(ctx);
        }
        const intent = quiesced ? "quiesced" : "running";
        renderRelocation(f.target, !quiesced);
        await expect(world.watchConverged(ctx, TARGET.clusterId, intent)).rejects.toThrow(/did not (converge|reach)/);
        renderRelocation(f.target, quiesced);
        await world.watchConverged(ctx, TARGET.clusterId, intent);
        // Inventory still names the source; refreshing that source would miss the current target.
        expect(f.source.argo.operations).toEqual([]);
        const generator = kind === "tenant" ? "tenants" : "consumer-apps";
        expect(f.target.argo.operations[0]).toBe(`refresh-set:${TARGET.cluster}/${generator}`);
        expect(f.target.argo.operations[1]).toMatch(/^refresh:s2\//);
        expect(f.target.argo.operations.findIndex((op) => op.startsWith("watch"))).toBeGreaterThan(1);
      });
    }
  }

  it("watches every CURRENT registration member, including a member absent from inventory", async () => {
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await ports.registrations.commitTenant({ stage: "prod", guid: GUID, runId: "run_create", registration: tenantEntry({ quiesced: true, members: testMembers(["extra", "web"]) }) });
    renderRelocation(f.source, true);
    const ctx = stepCtx(db, "watch", {}, []);
    const world = await tenantWorld(ports, "tnt_1")(ctx);
    await expect(world.watchConverged(ctx, SOURCE.clusterId, "quiesced")).rejects.toThrow(/extra-prod/);
    expect(f.source.argo.refreshed).toContain(`${SOURCE.cluster}/${GUID}-extra-prod`);
  });

  it("rejects a pending hard refresh even when the spec and old status look correct", async () => {
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await ports.registrations.commitTenant({ stage: "prod", guid: GUID, runId: "run_create", registration: tenantEntry({ quiesced: true }) });
    f.source.argo.setStatuses(new Map(["auth", "jobs", "report", "web"].map((m) => [`${GUID}-${m}-prod`, tenantStatus(true, m === "auth")])));
    const ctx = stepCtx(db, "watch", {}, []);
    await expect((await tenantWorld(ports, "tnt_1")(ctx)).watchConverged(ctx, SOURCE.clusterId, "quiesced")).rejects.toThrow(/refresh=pending/);
    const pending = new Map([["auth", tenantStatus(true, true)]]);
    expect(syncedAt(["auth"])(pending)).toBe(false);
    expect(describeUnsynced(["auth"], pending)).toContain("refresh=pending");
  });

  it("refuses source release while a registration-only member still stands", async () => {
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await ports.registrations.commitTenant({ stage: "prod", guid: GUID, runId: "run_create", registration: tenantEntry({ members: testMembers(["extra", "web"]) }) });
    f.source.argo.setStatuses(new Map([[`${GUID}-extra-prod`, tenantStatus(true)]]));
    const ctx = stepCtx(db, "verify-source-released", {}, []);
    const world = await tenantWorld(ports, "tnt_1")(ctx);
    expect(world.namespaces).toContain(`${GUID}-extra-prod`);
    await expect(world.verifySourceHandleReleased(ctx)).rejects.toThrow(/extra-prod/);
    f.source.argo.setStatuses(new Map());
    await world.verifySourceHandleReleased(ctx);
  });

  it("refreshes the source generator before measuring that the repoint pruned it", async () => {
    seedTenantRows(db);
    const f = makeFakes();
    const ports = tenantPorts(f);
    await seedTenantWorld(ports.registrations);
    f.source.argo.setStatuses(new Map());
    const ctx = stepCtx(db, "verify-source-released", {}, []);
    await (await tenantWorld(ports, "tnt_1")(ctx)).verifySourceHandleReleased(ctx);
    expect(f.source.argo.operations[0]).toBe(`refresh-set:${SOURCE.cluster}/tenants`);
    expect(f.source.argo.operations.at(-1)).toMatch(/^watch-set:s1\//);
  });
});
