import { Hono } from "hono";
import type { AppEnv } from "./app-env.ts";
import type { Wiring } from "../plugin.ts";
import type { Executor } from "../executor/executor.ts";
import type { PluginsView } from "../../shared/api-types.ts";

/** Mounts each active plugin's routes under /api/<its name>, and GET /api/plugins: the plugins this
 *  process activated, by name, which the SPA builds its menu and its routes from. Registered with the
 *  protected routes, so all of it stands behind the chokepoint and none of it on the public /healthz. */
export function registerPluginRoutes(app: Hono<AppEnv>, active: readonly { name: string; wiring: Wiring }[], ports: { executor: Executor }): void {
  for (const p of active) {
    if (!p.wiring.routes) continue;
    const routes = new Hono<AppEnv>();
    p.wiring.routes(routes, ports);
    app.route(`/api/${p.name}`, routes);
  }
  app.get("/api/plugins", (c) => c.json({ active: active.map((p) => p.name) } satisfies PluginsView));
}
