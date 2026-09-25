// The tenant family's probes for the scheduled unit check (plugins/unit/server/check-units.ts): per
// active, unsuspended tenant, the record its subdomain stands on.
import { and, eq } from "drizzle-orm";
import type { PreflightCheck } from "../../../shared/preflight.ts";
import { clusters, tenants } from "../../db/schema/inventory.ts";
import type { TenantOnboardPorts, CreateTenantParams } from "./create-tenant.run.ts";
import { probeTenantDns } from "./tenant-probes.ts";
import { failedProbe, unitProbeCtx, type UnitProbes } from "#unit/server/check-units.ts";

export function tenantUnitProbes(ports: Pick<TenantOnboardPorts, "dns" | "resolveUnitApex">): UnitProbes {
  return {
    noun: "tenant",
    probeAll: async (ctx, now) => {
      const done = { probed: 0, attention: 0 };
      const rows = ctx.db
        .select({ id: tenants.id, guid: tenants.guid, subdomain: tenants.subdomain, stage: tenants.stage, clusterId: tenants.clusterId, domain: clusters.domain })
        .from(tenants).innerJoin(clusters, eq(tenants.clusterId, clusters.id)).where(and(eq(tenants.status, "active"), eq(tenants.suspended, false))).all();
      for (const t of rows) {
        if (ctx.signal.aborted) break;
        let findings: PreflightCheck[];
        try {
          const p = { guid: t.guid, subdomain: t.subdomain, stage: t.stage, clusterId: t.clusterId, domain: t.domain } as CreateTenantParams;
          findings = await probeTenantDns(ports as TenantOnboardPorts, p, unitProbeCtx(ctx, t.subdomain));
        } catch (err) {
          findings = [failedProbe("dns.record", `The DNS record of ${t.subdomain}`, err)];
        }
        ctx.db.update(tenants).set({ checkJson: { checkedAt: now.getTime(), findings }, updatedAt: now }).where(eq(tenants.id, t.id)).run();
        done.probed += 1;
        done.attention += findings.filter((f) => f.status !== "pass").length;
      }
      return done;
    },
  };
}
