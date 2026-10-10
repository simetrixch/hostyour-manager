import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb, type DbHandle } from "#core/server/db/client.ts";
import { runAsActor } from "#core/server/kernel/actor.ts";
import { unitPlugin } from "./plugin.ts";
import { unitSizes } from "./schema.ts";
import { seedUnitSizes } from "./unit-size.ts";

// The stamps of the size table, and migration 0002 of the unit's ledger, which put them on the rows an
// installation held.

let h: DbHandle | undefined;
afterEach(() => h?.sqlite.close());

const BASE_SMALL = and(eq(unitSizes.component, "base"), eq(unitSizes.name, "small"));

describe("the stamps of the size table", () => {
  it("name the operator who seeded a size and the one who changed it", async () => {
    const opened = (h = openDb(":memory:", [unitPlugin]));
    runAsActor("op_a", () => seedUnitSizes(opened.db));
    const seeded = opened.db.select().from(unitSizes).where(BASE_SMALL).get();
    expect(seeded).toMatchObject({ owner: "op_a", modifiedBy: "op_a" });
    expect(seeded?.modified).toEqual(seeded?.creation);
    await new Promise((r) => setTimeout(r, 5)); // the clock is read in milliseconds
    runAsActor("op_b", () => opened.db.update(unitSizes).set({ pods: 99 }).where(BASE_SMALL).run());
    const changed = opened.db.select().from(unitSizes).where(BASE_SMALL).get();
    expect(changed).toMatchObject({ pods: 99, creation: seeded?.creation, owner: "op_a", modifiedBy: "op_b" });
    expect(changed?.modified.getTime()).toBeGreaterThan(seeded?.modified.getTime() ?? Infinity);
  });

  it("carries a size the core's baseline held through migration 0002, with the time it recorded", () => {
    // Opened without the unit's tree, the database holds unit_sizes as the core's baseline created it.
    const opened = (h = openDb(":memory:"));
    opened.sqlite
      .prepare("INSERT INTO unit_sizes (component, name, requests_cpu, requests_memory, limits_cpu, limits_memory, pods, persistent_volume_claims, updated_at) VALUES ('base', 'small', '900m', '1Gi', '2', '2Gi', 10, 5, 1700000000000)")
      .run();
    migrate(opened.db, { migrationsFolder: unitPlugin.migrations, migrationsTable: "__drizzle_migrations_unit" });
    expect(opened.sqlite.prepare("SELECT * FROM unit_sizes").all()).toEqual([{
      component: "base", name: "small", requests_cpu: "900m", requests_memory: "1Gi", limits_cpu: "2", limits_memory: "2Gi", pods: 10, persistent_volume_claims: 5,
      creation: 1700000000000, modified: 1700000000000, owner: "unrecorded", modified_by: "unrecorded",
    }]);
  });
});
