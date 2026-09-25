// The unit plugin's ports as its own activation provides them, for a test that builds the families
// over a parsed config: the plugin reads nothing of the core but the Vault settings, and no key of
// its own is set.
import type { Config } from "#core/server/kernel/config.ts";
import type { Core } from "#core/server/plugin.ts";
import { unitPlugin, unitPorts, type UnitPorts } from "./plugin.ts";

export function unitPortsOver(config: Config): UnitPorts {
  const core = { config } as unknown as Core;
  return unitPorts(unitPlugin.activate(core, {}).provides);
}
