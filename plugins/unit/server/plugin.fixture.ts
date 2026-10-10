// The unit plugin as a boot leaves it, for a test: its ports over a parsed config, and the database
// with the plugin's own migrations applied and its size table seeded.
import type { Config } from "#core/server/kernel/config.ts";
import type { Core } from "#core/server/plugin.ts";
import { openDb, type DbHandle } from "#core/server/db/client.ts";
import { unitPlugin, unitPorts, type UnitPorts } from "./plugin.ts";
import { seedUnitSizes } from "./unit-size.ts";

/** The plugin's ports as its own activation provides them: the plugin reads nothing of the core but
 *  the Vault settings, and no key of its own is set. */
export function unitPortsOver(config: Config): UnitPorts {
  const core = { config } as unknown as Core;
  return unitPorts(unitPlugin.activate(core, {}).provides);
}

/** The Manager's database as a boot opens it for the unit plugin: the core's migrations, then the
 *  plugin's own, and the size table seeded. In memory unless a file is named. */
export function openUnitDb(file = ":memory:"): DbHandle {
  const handle = openDb(file, [unitPlugin]);
  seedUnitSizes(handle.db);
  return handle;
}
