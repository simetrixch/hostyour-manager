import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "./client.ts";
import { servers, clusters, apps, tenants, tenantApps } from "./schema/inventory.ts";
import { runAsActor } from "../kernel/actor.ts";

// The stamp columns of the inventory tables (db/schema/stamps.ts): drizzle writes them on every insert
// and update, from the actor the call chain is bound to. Lives beside inventory-schema.test.ts, outside
// schema/, so drizzle-kit's schema glob never reads a test.

let db: DbHandle;
afterEach(() => db?.sqlite.close());

interface Stamps { creation: number; modified: number; owner: string; modified_by: string }
const TABLES = ["servers", "clusters", "apps", "tenants", "tenant_apps"] as const;
type Table = (typeof TABLES)[number];
const ROWS: Record<Table, string> = { servers: "srv_1", clusters: "cls_1", apps: "app_1", tenants: "tnt_1", tenant_apps: "tna_1" };

function seed(): void {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: ROWS.servers, name: "s1", host: "10.0.0.1", sshUser: "root" }).run();
  db.db.insert(clusters).values({ id: ROWS.clusters, serverId: ROWS.servers, stage: "prod", domain: "s1.example", name: "s1" }).run();
  db.db.insert(apps).values({ id: ROWS.apps, clusterId: ROWS.clusters, name: "post", stage: "prod", host: "post.example" }).run();
  db.db.insert(tenants).values({ id: ROWS.tenants, clusterId: ROWS.clusters, guid: "abcdefghjkmn", subdomain: "acme", stage: "prod", identityProvider: "idp", members: [] }).run();
  db.db.insert(tenantApps).values({ id: ROWS.tenant_apps, tenantId: ROWS.tenants, name: "erp" }).run();
}
function change(): void {
  db.db.update(servers).set({ notes: "moved" }).where(eq(servers.id, ROWS.servers)).run();
  db.db.update(clusters).set({ status: "active" }).where(eq(clusters.id, ROWS.clusters)).run();
  db.db.update(apps).set({ status: "suspended" }).where(eq(apps.id, ROWS.apps)).run();
  db.db.update(tenants).set({ displayName: "Acme" }).where(eq(tenants.id, ROWS.tenants)).run();
  db.db.update(tenantApps).set({ status: "offboarded" }).where(eq(tenantApps.id, ROWS.tenant_apps)).run();
}
const stampsOf = (table: Table): Stamps =>
  db.sqlite.prepare(`SELECT creation, modified, owner, modified_by FROM ${table} WHERE id = ?`).get(ROWS[table]) as Stamps;

describe("the stamps of servers, clusters, apps, tenants and tenant apps", () => {
  it("name the bound operator on all four fields, and equal times, on an insert", () => {
    runAsActor("op_a", seed);
    for (const table of TABLES) {
      const row = stampsOf(table);
      expect({ table, owner: row.owner, modifiedBy: row.modified_by, same: row.modified === row.creation }).toEqual({ table, owner: "op_a", modifiedBy: "op_a", same: true });
      expect(row.creation).toBeGreaterThan(0);
    }
  });

  it("name the system outside any request", () => {
    seed();
    for (const table of TABLES) expect([table, stampsOf(table).owner, stampsOf(table).modified_by]).toEqual([table, "op_system", "op_system"]);
  });

  it("move modified and modified_by only when another operator updates the row", async () => {
    runAsActor("op_a", seed);
    const before = Object.fromEntries(TABLES.map((t) => [t, stampsOf(t)])) as Record<Table, Stamps>;
    await new Promise((r) => setTimeout(r, 5)); // the clock is read in milliseconds
    runAsActor("op_b", change);
    for (const table of TABLES) {
      const after = stampsOf(table);
      expect({ table, creation: after.creation, owner: after.owner, modifiedBy: after.modified_by }).toEqual({ table, creation: before[table].creation, owner: "op_a", modifiedBy: "op_b" });
      expect(after.modified).toBeGreaterThan(before[table].modified);
    }
  });
});
