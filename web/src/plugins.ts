import type { Plugin } from "./plugin.ts";
import { unitWebPlugin } from "#unit/web/plugin.tsx";

/** The web halves of the plugins this product compiles, one import each. Which of them show is the
 *  server's answer (GET /api/plugins). */
export const compiledPlugins: readonly Plugin[] = [unitWebPlugin];
