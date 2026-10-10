// The tenant family's probes for the scheduled unit check (plugins/unit/server/check-units.ts): per
// active, unsuspended tenant, the record its subdomain stands on, and the build hook of every unit that
// builds an image the tenant runs. Those units are build-only: they have no row of their own, so the
// tenant's row is where a push that starts no build shows.
import { and, eq } from "drizzle-orm";
import type { PreflightCheck } from "../../../shared/preflight.ts";
import type { Stage } from "../../../shared/enums.ts";
import { clusters, tenants } from "../../db/schema/inventory.ts";
import type { TenantOnboardPorts, CreateTenantParams } from "./create-tenant.run.ts";
import { buildUnitTitle, probeBuildUnit, probeTenantDns } from "./tenant-probes.ts";
import { failedProbe, stagePlacementFinding, unitProbeCtx, type UnitProbes } from "#unit/server/check-units.ts";
import type { ProbeCtx } from "../../executor/probe.ts";

type TenantProbePorts = Pick<TenantOnboardPorts, "dns" | "resolveUnitApex"> &
  Partial<Pick<TenantOnboardPorts, "registrations" | "onboard" | "githubApp">>;

/** A build registration as the walk reads it: the repository, and the build names it attests. */
type BuildUnitEntry = { unit: string; repoURL: string; builds: readonly string[] };

/** The units that build what the tenant's registration pins: the build names under `approvedTags`,
 *  matched against the names each build registration attests. */
async function buildUnitsOf(ports: TenantProbePorts, stage: Stage, guid: string, unitsOf: () => Promise<BuildUnitEntry[]>): Promise<BuildUnitEntry[]> {
  if (!ports.registrations) return [];
  const read = await ports.registrations.readTenant(stage, guid);
  const names = new Set(Object.values(read?.entry.approvedTags ?? {}).flatMap((builds) => Object.keys(builds)));
  return (await unitsOf()).filter((u) => u.builds.some((b) => names.has(b))).sort((a, b) => a.unit.localeCompare(b.unit));
}

export function tenantUnitProbes(ports: TenantProbePorts): UnitProbes {
  return {
    noun: "tenant",
    probeAll: async (ctx, now) => {
      const done = { probed: 0, attention: 0 };
      // Once per walk: the build registrations, and each unit's hook, however many tenants run it.
      let units: Promise<BuildUnitEntry[]> | undefined;
      const unitsOf = (): Promise<BuildUnitEntry[]> =>
        (units ??= (async () => {
          const registrations = ports.onboard?.()?.ports.registrations;
          const list = registrations ? await registrations.listBuildRegistrations() : [];
          return list.map(({ unit, entry }) => ({ unit, repoURL: entry.repoURL, builds: entry.builds ?? [] }));
        })());
      const hooks = new Map<string, Promise<PreflightCheck[]>>();
      const hookOf = (unit: string, repoURL: string, domain: string, probeCtx: ProbeCtx): Promise<PreflightCheck[]> => {
        if (!hooks.has(unit)) {
          hooks.set(unit, probeBuildUnit(() => ports.onboard?.(), ports, { domain }, { unit, repoURL, images: [], registered: true }, probeCtx, true)
            .catch((err: unknown) => [failedProbe(`unit.${unit}`, buildUnitTitle(unit, repoURL), err)]));
        }
        return hooks.get(unit)!;
      };
      const rows = ctx.db
        .select({ id: tenants.id, guid: tenants.guid, subdomain: tenants.subdomain, stage: tenants.stage, clusterId: tenants.clusterId, domain: clusters.domain, clusterStage: clusters.stage })
        .from(tenants).innerJoin(clusters, eq(tenants.clusterId, clusters.id)).where(and(eq(tenants.status, "active"), eq(tenants.suspended, false))).all();
      for (const t of rows) {
        if (ctx.signal.aborted) break;
        const probeCtx = unitProbeCtx(ctx, t.subdomain);
        const findings: PreflightCheck[] = [stagePlacementFinding(`${t.subdomain} ${t.stage}`, t.stage, { domain: t.domain, stage: t.clusterStage })];
        try {
          const p = { guid: t.guid, subdomain: t.subdomain, stage: t.stage, clusterId: t.clusterId, domain: t.domain } as CreateTenantParams;
          findings.push(...(await probeTenantDns(ports as TenantOnboardPorts, p, probeCtx)));
        } catch (err) {
          findings.push(failedProbe("dns.record", `The DNS record of ${t.subdomain}`, err));
        }
        try {
          for (const u of await buildUnitsOf(ports, t.stage as Stage, t.guid, unitsOf)) findings.push(...(await hookOf(u.unit, u.repoURL, t.domain, probeCtx)));
        } catch (err) {
          findings.push(failedProbe("units", `The build units of ${t.subdomain}`, err));
        }
        ctx.db.update(tenants).set({ checkJson: { checkedAt: now.getTime(), findings } }).where(eq(tenants.id, t.id)).run();
        done.probed += 1;
        done.attention += findings.filter((f) => f.status !== "pass").length;
      }
      return done;
    },
  };
}
