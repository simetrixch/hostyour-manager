import type { Plugin } from "./plugin.ts";
import { unitPlugin } from "#unit/server/plugin.ts";

/** The plugins this product compiles, one import each; the key PLUGINS names which of them are
 *  active. Every compiled plugin's tables are migrated, active or not. */
export const compiledPlugins: readonly Plugin[] = [unitPlugin];
