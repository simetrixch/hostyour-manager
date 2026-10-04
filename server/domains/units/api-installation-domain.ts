import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { InstallationDomainParamsSchema } from "../../../shared/installation-domain.ts";
import { readInstallationDomain, type InstallationDomainPorts } from "./installation-domain.ts";

/** A provider/books read only: unlike a run plan, this creates no run or audit row. */
export function registerInstallationDomainRoutes(app: Hono<AppEnv>, db: Db, ports: InstallationDomainPorts): void {
  app.get("/api/installation-domain/preview", async c => {
    const params = InstallationDomainParamsSchema.parse({ fromDomain: c.req.query("fromDomain"), toDomain: c.req.query("toDomain"), dryRun: true });
    return c.json(await readInstallationDomain(db, ports, params.fromDomain, params.toDomain, c.req.raw.signal));
  });
}
