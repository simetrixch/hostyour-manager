import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import pino from "pino";
import { ConfigError } from "../kernel/config.ts";
import type { Core, Plugin } from "../plugin.ts";
import { openDb, type DbHandle } from "../db/client.ts";
import { unitSizes } from "../db/schema/inventory.ts";
import { RUN_KIND } from "../../shared/enums.ts";
import type { Executor } from "../executor/executor.ts";
import { compiledPlugins } from "../plugins.ts";
import { activatePlugins } from "./plugin-set.ts";
import { Hono } from "hono";
import type { AppEnv } from "../http/app-env.ts";
import { registerPluginRoutes } from "../http/plugins-route.ts";
import { unitPorts } from "#unit/server/plugin.ts";

// THE PRODUCT'S OWN SET, activated the way a boot activates it (wire.ts): the plugins this build
// compiles, the names PLUGINS gives, the process env, and the run kinds the core brings.

const coreKinds = new Set<string>(RUN_KIND);
const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.sqlite.close();
});

/** A core carrying what the unit plugin reads: the database it seeds, the logger, and no Vault. */
function core(): Omit<Core, "plugins"> {
  const h = openDb(":memory:");
  handles.push(h);
  return { config: {}, db: h.db, logger: pino({ level: "silent" }) } as unknown as Omit<Core, "plugins">;
}

function refusal(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  throw new Error("nothing was refused");
}

/** The second family as it will stand beside the unit plugin: it requires unit, and brings nothing. */
const consumer: Plugin = {
  name: "consumer",
  requires: ["unit"],
  env: z.object({}),
  schema: {},
  migrations: "unused",
  activate: (c) => ({ definitions: [], provides: { unitSeen: c.plugins.unit !== undefined } }),
};

const BOX = { STORAGE_BOX_HOST: "box.example", STORAGE_BOX_USER: "u1", STORAGE_BOX_PASSWORD: "secret" };

describe("the plugins this product compiles", () => {
  it("activates unit for PLUGINS=unit: its ports for the families, and the size table seeded at boot", async () => {
    const c = core();
    const active = activatePlugins(compiledPlugins, ["unit"], c, {}, coreKinds);
    expect(active.map((p) => p.name)).toEqual(["unit"]);
    const wiring = active[0]!.wiring;
    expect(wiring.definitions).toEqual([]);
    const ports = unitPorts(wiring.provides);
    expect(Object.keys(ports).sort()).toEqual(["activator", "github", "relocation", "seeder"]);
    expect(ports.relocation.storageBox).toBeUndefined();
    expect(ports.relocation.dbtoolsImage).toBeUndefined();

    expect(c.db.select().from(unitSizes).all()).toEqual([]);
    await wiring.onBoot?.({ executor: {} as Executor });
    expect(c.db.select().from(unitSizes).all()).toHaveLength(9);
  });

  it("serves the size table under /api/unit, where the core mounts the unit plugin's routes", async () => {
    const c = core();
    const active = activatePlugins(compiledPlugins, ["unit"], c, {}, coreKinds);
    await active[0]!.wiring.onBoot?.({ executor: {} as Executor });
    const app = new Hono<AppEnv>();
    registerPluginRoutes(app, active, { executor: {} as Executor });
    const sizes = await app.request("/api/unit/sizes");
    expect(sizes.status).toBe(200);
    expect(((await sizes.json()) as { sizes: unknown[] }).sizes).toHaveLength(9);
    expect((await app.request("/api/unit-sizes")).status).toBe(404);
    expect(((await (await app.request("/api/plugins")).json()) as { active: string[] }).active).toEqual(["unit"]);
  });

  it("hands the families the staging area and the job image its keys configure", () => {
    const active = activatePlugins(compiledPlugins, ["unit"], core(), { ...BOX, DBTOOLS_IMAGE: "registry.example/dbtools:1.0.0" }, coreKinds);
    const { relocation } = unitPorts(active[0]!.wiring.provides);
    expect(relocation.storageBox).toEqual({ host: "box.example", user: "u1", password: "secret" });
    expect(relocation.dbtoolsImage).toBe("registry.example/dbtools:1.0.0");
  });

  it("activates nothing for an empty PLUGINS: the core alone is a product", () => {
    expect(activatePlugins(compiledPlugins, [], core(), {}, coreKinds)).toEqual([]);
  });

  it("refuses consumer without unit, and hands consumer the unit's ports where both are named", () => {
    expect(refusal(() => activatePlugins([...compiledPlugins, consumer], ["consumer"], core(), {}, coreKinds)))
      .toEqual(["consumer requires unit, which PLUGINS does not name"]);
    const both = activatePlugins([...compiledPlugins, consumer], ["consumer", "unit"], core(), {}, coreKinds);
    expect(both.map((p) => p.name)).toEqual(["unit", "consumer"]);
    expect(both[1]!.wiring.provides).toEqual({ unitSeen: true });
  });

  it("refuses the unit's keys while PLUGINS does not name it: an unused key is never dropped in silence", () => {
    expect(refusal(() => activatePlugins(compiledPlugins, [], core(), { ...BOX, DBTOOLS_IMAGE: "registry.example/dbtools:1.0.0" }, coreKinds))).toEqual([
      "STORAGE_BOX_HOST is set, but it belongs to unit, which PLUGINS does not name",
      "STORAGE_BOX_USER is set, but it belongs to unit, which PLUGINS does not name",
      "STORAGE_BOX_PASSWORD is set, but it belongs to unit, which PLUGINS does not name",
      "DBTOOLS_IMAGE is set, but it belongs to unit, which PLUGINS does not name",
    ]);
  });

  it("refuses a staging area named by fewer than its three keys", () => {
    expect(refusal(() => activatePlugins(compiledPlugins, ["unit"], core(), { STORAGE_BOX_HOST: "box.example" }, coreKinds))).toEqual([
      "unit: STORAGE_BOX_HOST: STORAGE_BOX_HOST, STORAGE_BOX_USER and STORAGE_BOX_PASSWORD must be set together (the staging area needs all three, or none)",
    ]);
  });
});
