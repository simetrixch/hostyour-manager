import { describe, it, expect, beforeEach } from "vitest";
import type { DbHandle } from "../../db/client.ts";
import { runUnitCard } from "./run-unit-card.ts";
import { openFixtureDb, seedClusters, seedConsumerRow, seedTenantRows, CONSUMER, GUID, SUBDOMAIN } from "./relocation.fixture.ts";

let db: DbHandle;
beforeEach(() => { db = openFixtureDb(); });

describe("runUnitCard", () => {
  it("PLANTED: a run on a consumer's TEST stage names its card at TEST, not PROD", () => {
    seedClusters(db);
    seedConsumerRow(db, "active", "test");
    expect(runUnitCard(db.db, { targetKind: "app", targetId: "app_1" })).toEqual({ page: "consumers", key: CONSUMER, label: CONSUMER, stage: "test" });
  });

  it("a run on a tenant stage names the tenant's card by its guid, labelled by its subdomain", () => {
    seedClusters(db);
    seedTenantRows(db);
    expect(runUnitCard(db.db, { targetKind: "tenant", targetId: "tnt_1" })).toEqual({ page: "tenants", key: GUID, label: SUBDOMAIN, stage: "prod" });
  });

  it("a run on anything else, or on a unit whose row is gone, has no card", () => {
    seedClusters(db);
    expect(runUnitCard(db.db, { targetKind: "cluster", targetId: "cls_1" })).toBeNull();
    expect(runUnitCard(db.db, { targetKind: "app", targetId: "app_gone" })).toBeNull();
  });
});
