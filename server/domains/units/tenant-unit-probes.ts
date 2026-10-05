// The tenant family's probes for the scheduled unit check (plugins/unit/server/check-units.ts): per
// active, unsuspended tenant, the record its subdomain stands on, and the build hook of every unit that
// builds an image the tenant runs. Those units are build-only: they have no row of their own, so the
// tenant's row is where a push that starts no build shows.
import { and, eq } from "drizzle-orm";
import type { PreflightCheck } from "../../../shared/preflight.ts";
import type { Stage } from "../../../shared/enums.ts";
import { clusters, tenants } from "../../db/schema/inventory.ts";
import type { TenantOnboardPorts, CreateTenantParams } from "./create-tenant.run.ts";
import { probeBuildUnit, probeTenantDns } from "./tenant-probes.ts";
import { failedProbe, unitProbeCtx, type UnitProbes } from "#unit/server/check-units.ts";
import type { ProbeCtx } from "../../executor/probe.ts";

type TenantProbePorts = Pick<TenantOnboardPorts, "dns" | "resolveUnitApex"> &
  Partial<Pick<TenantOnboardPorts, "registrations" | "attestedBuilds" | "onboard" | "githubApp">>;

/** The units that build what the tenant's registration pins, each with its repository: the build
 *  names under `approvedTags`, matched against the names each build registration attests. */
async function buildUnitsOf(ports: TenantProbePorts, stage: Stage, guid: string, repoOf: () => Promise<Map<string, string>>): Promise<{ unit: string; repoURL: string }[]> {
  if (!ports.registrations || !ports.attestedBuilds) return [];
  const read = await ports.registrations.readTenant(stage, guid);
  const names = new Set(Object.values(read?.entry.approvedTags ?? {}).flatMap((builds) => Object.keys(builds)));
  const units = [...new Set((await ports.attestedBuilds()).filter((a) => names.has(a.build)).map((a) => a.unit))].sort();
  const repos = await repoOf();
  return units.flatMap((unit) => {
    const repoURL = repos.get(unit);
    return repoURL ? [{ unit, repoURL }] : [];
  });
}

export function tenantUnitProbes(ports: TenantProbePorts): UnitProbes {
  return {
    noun: "tenant",
    probeAll: async (ctx, now) => {
      const done = { probed: 0, attention: 0 };
      // Once per walk: the build registrations, and each unit's hook, however many tenants run it.
      let repos: Promise<Map<string, string>> | undefined;
      const repoOf = (): Promise<Map<string, string>> =>
        (repos ??= (async () => {
          const registrations = ports.onboard?.()?.ports.registrations;
          const list = registrations ? await registrations.listBuildRegistrations() : [];
          return new Map(list.map(({ unit, entry }) => [unit, entry.repoURL]));
        })());
      const hooks = new Map<string, Promise<PreflightCheck[]>>();
      const hookOf = (unit: string, repoURL: string, domain: string, probeCtx: ProbeCtx): Promise<PreflightCheck[]> => {
        if (!hooks.has(unit)) {
          hooks.set(unit, probeBuildUnit(() => ports.onboard?.(), ports, { domain }, { unit, repoURL, images: [], registered: true }, probeCtx, true)
            .catch((err: unknown) => [failedProbe(`unit.${unit}`, `The build unit ${unit}`, err)]));
        }
        return hooks.get(unit)!;
      };
      const rows = ctx.db
        .select({ id: tenants.id, guid: tenants.guid, subdomain: tenants.subdomain, stage: tenants.stage, clusterId: tenants.clusterId, domain: clusters.domain })
        .from(tenants).innerJoin(clusters, eq(tenants.clusterId, clusters.id)).where(and(eq(tenants.status, "active"), eq(tenants.suspended, false))).all();
      for (const t of rows) {
        if (ctx.signal.aborted) break;
        const probeCtx = unitProbeCtx(ctx, t.subdomain);
        const findings: PreflightCheck[] = [];
        try {
          const p = { guid: t.guid, subdomain: t.subdomain, stage: t.stage, clusterId: t.clusterId, domain: t.domain } as CreateTenantParams;
          findings.push(...(await probeTenantDns(ports as TenantOnboardPorts, p, probeCtx)));
        } catch (err) {
          findings.push(failedProbe("dns.record", `The DNS record of ${t.subdomain}`, err));
        }
        try {
          for (const u of await buildUnitsOf(ports, t.stage as Stage, t.guid, repoOf)) findings.push(...(await hookOf(u.unit, u.repoURL, t.domain, probeCtx)));
        } catch (err) {
          findings.push(failedProbe("units", `The build units of ${t.subdomain}`, err));
        }
        ctx.db.update(tenants).set({ checkJson: { checkedAt: now.getTime(), findings }, updatedAt: now }).where(eq(tenants.id, t.id)).run();
        done.probed += 1;
        done.attention += findings.filter((f) => f.status !== "pass").length;
      }
      return done;
    },
  };
}
