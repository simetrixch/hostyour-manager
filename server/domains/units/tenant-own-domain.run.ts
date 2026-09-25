import { z } from "zod";
import { and, eq, ne, notInArray } from "drizzle-orm";
import type { Cleanup, RunDefinition, Step, StepCtx } from "../../executor/types.ts";
import { publicFqdn } from "../../../shared/consumer.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { errValidation } from "../../kernel/errors.ts";
import { clusters, tenants } from "../../db/schema/inventory.ts";
import { findDnsWrite, recordDnsWrite } from "../../db/dns-writes.ts";
import { DnsZoneUnknownError } from "../../adapters/dns/port.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantCluster } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { isTenantRecord, removeUnitDns, tenantMemberUrl, tenantZone } from "./unit-dns.ts";
import { sleep } from "./onboard-release-cycle.ts";
import type { TenantSetRoutingPorts } from "./tenant-routing.run.ts";

// `tenant-set-own-domain` — set, switch or clear the ONE own domain of a standing tenant.
//
// WHY IT EXISTS. A tenant is reached at its zone `<subdomain>.<stage apex>`. A customer may bring an
// own domain instead, which replaces the zone as the tenant's one host: every member stands under a
// path of it (so it needs `path` routing), and the zone's own record stays, because the product's
// charts answer the zone with a redirect to the domain. The customer may switch the domain later.
//
// THE DOMAIN'S RECORD is a CNAME onto the tenant's ZONE, never onto a cluster: the zone record follows
// the cluster through every move and rename, so a record in a zone the customer manages never has to
// change again. Where this installation's DNS provider manages the domain's zone, the run writes the
// record; where it does not, the run names the record the operator sets and waits for it.
//
// THE WAIT BEFORE THE REMOVAL, as in tenant-set-routing: the previous domain's record goes only once
// the tenant's IdP answers a 2xx at the new host, and the wait and the removal are one step, so
// skipping a failed wait removes nothing. An abort records the previous domain again and removes the
// new domain's record where this run wrote it.

const ownDomain = z.union([z.literal(""), publicFqdn]);

export const TenantSetOwnDomainParams = z.object({
  tenantId: z.string().startsWith("tnt_"),
  /** The own domain to set, or "" to clear it and return the tenant to its zone. */
  ownDomain,
  /** The own domain the tenant had when this was asked for ("" = none). The plan refuses a tenant that
   *  has moved since, and an abort records it again. */
  previous: ownDomain,
});
export type TenantSetOwnDomainParams = z.infer<typeof TenantSetOwnDomainParams>;

export type TenantSetOwnDomainPorts = TenantSetRoutingPorts;

/** The host a tenant is reached at: its own domain, or its zone where it has none. */
function tenantHost(tc: TenantCluster, apex: string, domain: string): string {
  return domain || tenantZone(tc.subdomain, tc.stage, apex);
}

/** Point `domain` at the tenant's zone, where this installation's DNS provider manages the domain's
 *  zone, and enter the write into the book. Where it does not, say which record the operator sets. */
async function provisionOwnDomainRecord(ctx: StepCtx, ports: TenantSetOwnDomainPorts, tc: TenantCluster, apex: string, domain: string): Promise<void> {
  const zone = tenantZone(tc.subdomain, tc.stage, apex);
  const operatorSets = `set CNAME ${domain} → ${zone} at the provider of ${domain}; the wait below ends once the tenant answers there`;
  if (!ports.dns) {
    ctx.log("meta", `no DNS provider is configured on this manager: ${operatorSets}`);
    return;
  }
  let standing: string | null;
  try {
    standing = await ports.dns.readRecordContent({ name: domain, type: "CNAME", signal: ctx.signal });
  } catch (e) {
    if (e instanceof DnsZoneUnknownError) {
      ctx.log("meta", `the DNS zone of ${domain} is not managed here: ${operatorSets}`);
      return;
    }
    throw e;
  }
  if (standing !== null && standing !== zone && !isTenantRecord(ctx.db, domain, tc.guid)) {
    throw errValidation(`${domain} stands as CNAME ${standing}, and the book of DNS writes does not name it tenant ${tc.guid}'s — remove it at the provider first, or choose another domain`);
  }
  if (standing === zone) {
    if (findDnsWrite(ctx.db, { name: domain, type: "CNAME" }) === null) {
      recordDnsWrite(ctx.db, { name: domain, type: "CNAME", content: zone, act: "updated", owner: { kind: "tenant", name: tc.guid, stage: tc.stage }, runId: ctx.runId });
    }
    ctx.log("meta", `${domain} already points at ${zone}`);
    return;
  }
  // A CNAME stands alone under its name, so an address record there goes first.
  if ((await ports.dns.readRecordContent({ name: domain, type: "A", signal: ctx.signal })) !== null) {
    throw errValidation(`${domain} carries an A record — a CNAME cannot stand beside it; remove it at the provider first`);
  }
  const { created } = await ports.dns.upsertRecord({ name: domain, type: "CNAME", content: zone, signal: ctx.signal });
  recordDnsWrite(ctx.db, { name: domain, type: "CNAME", content: zone, act: standing === null ? "inserted" : "updated", owner: { kind: "tenant", name: tc.guid, stage: tc.stage }, runId: ctx.runId });
  ctx.log("meta", `DNS record ${domain} → CNAME ${zone} ${created ? "created" : "updated"}`);
}

/** Remove `domain`'s record where this installation wrote it for this tenant (the book says so). A
 *  record in a zone nobody here manages is the operator's to remove, and the run says so. */
async function removeOwnDomainRecord(ctx: StepCtx, ports: TenantSetOwnDomainPorts, tc: TenantCluster, domain: string): Promise<void> {
  if (!isTenantRecord(ctx.db, domain, tc.guid)) {
    ctx.log("meta", `${domain} is not recorded as tenant ${tc.guid}'s own record — if it points at the tenant, remove it at its provider`);
    return;
  }
  await removeUnitDns(ctx, { dns: ports.dns, unit: tc.guid, recordName: domain });
}

/** On abort: put the previous own domain back on the registration and the row. */
function restoreOwnDomainCleanup(ports: TenantSetOwnDomainPorts, tenantId: string, previous: string): Cleanup {
  return {
    name: "restore-own-domain",
    title: `Record the previous own domain (${previous || "none"}) again`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, tenantId);
      const { commit } = await ports.registrations.setOwnDomain(tc.stage, tc.guid, previous, ctx.runId);
      ctx.db.update(tenants).set({ ownDomain: previous, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, tenantId)).run();
      ctx.log("meta", `tenant ${tc.guid} own domain back to ${previous || "none"} (${commit})`);
    },
  };
}

/** On abort: remove the requested domain's record — unless the tenant's recorded own domain is that
 *  domain after all. Runs after restore-own-domain (cleanups run in reverse order). */
function removeNewRecordCleanup(ports: TenantSetOwnDomainPorts, p: TenantSetOwnDomainParams): Cleanup {
  return {
    name: "remove-new-own-domain-record",
    title: `Remove the DNS record of ${p.ownDomain || "no domain"}, where the tenant does not use it`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, p.tenantId);
      if (p.ownDomain === "" || tc.ownDomain === p.ownDomain) return;
      await removeOwnDomainRecord(ctx, ports, tc, p.ownDomain);
    },
  };
}

function tenantSetOwnDomainSteps(ports: TenantSetOwnDomainPorts, p: TenantSetOwnDomainParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "provision-own-domain-record",
      title: "Point the new own domain at the tenant's zone",
      run: async (ctx) => {
        if (p.ownDomain === "") {
          ctx.log("meta", "no own domain is set — the tenant returns to its zone, whose record stands");
          return;
        }
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        ctx.registerCleanup(removeNewRecordCleanup(ports, p));
        await provisionOwnDomainRecord(ctx, ports, tc, await ports.resolveUnitApex(tc.domain, tc.stage), p.ownDomain);
      },
    },
    {
      name: "write-own-domain",
      title: "Record the own domain on the tenant's registration and row",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        // The plan's facts, asked again: another run may have moved the tenant since it was planned.
        // A resume finds its own write already standing.
        if (tc.ownDomain !== p.previous && tc.ownDomain !== p.ownDomain) throw errValidation(`tenant ${tc.subdomain} has the own domain ${tc.ownDomain || "none"} now, not ${p.previous || "none"} as when this run was planned — plan it again`);
        if (p.ownDomain !== "" && tc.routing !== "path") throw errValidation(`tenant ${tc.subdomain} is on ${tc.routing} routing now — an own domain needs path routing; plan it again`);
        ctx.registerCleanup(restoreOwnDomainCleanup(ports, p.tenantId, p.previous));
        const { commit } = await ports.registrations.setOwnDomain(tc.stage, tc.guid, p.ownDomain, ctx.runId);
        ctx.db.update(tenants).set({ ownDomain: p.ownDomain, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit });
        ctx.log("meta", `tenant ${tc.guid} own domain ${p.previous || "none"} → ${p.ownDomain || "none"} (${commit}) — its charts serve it once the ArgoCD on ${tc.domain} syncs`);
      },
    },
    {
      name: "retire-previous-own-domain",
      title: "Wait until the tenant's identity provider answers at its new host, then remove the previous domain's record",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
        const url = `${tenantMemberUrl("path", tc.identityProvider, tc.stage, tc.subdomain, apex, p.ownDomain)}/`;
        const deadline = Date.now() + ports.routingWaitMs;
        for (;;) {
          const seen = await ports.probe.probe(url, { signal: ctx.signal });
          if (seen.status !== null && seen.status >= 200 && seen.status < 300) {
            ctx.log("meta", `${url} answers (${seen.detail}) — the tenant is served at ${tenantHost(tc, apex, p.ownDomain)}`);
            break;
          }
          if (ctx.signal.aborted) throw errValidation(`the wait for ${url} was cancelled`);
          if (Date.now() >= deadline) {
            throw errValidation(
              `${url} did not answer with a 2xx within ${Math.round(ports.routingWaitMs / 60_000)} minutes (last: ${seen.detail}) — ` +
              `its record, its certificate or the product's charts are not in place yet. The previous host still stands: ` +
              `retry this step once they are, or abort the run to record the previous own domain again.`,
            );
          }
          ctx.log("meta", `${url} does not answer yet (${seen.detail}); asking again in ${Math.round(ports.routingPollMs / 1000)}s`);
          await sleep(ports.routingPollMs, ctx.signal);
        }
        if (p.previous !== "" && p.previous !== p.ownDomain) await removeOwnDomainRecord(ctx, ports, tc, p.previous);
      },
    },
  ];
}

export function makeTenantSetOwnDomainDef(ports: TenantSetOwnDomainPorts): RunDefinition<TenantSetOwnDomainParams> {
  return {
    kind: "tenant-set-own-domain",
    paramsSchema: TenantSetOwnDomainParams,
    mutating: true,
    plan: async (params, { db }) => {
      const tc = loadTenantCluster(db, params.tenantId);
      const row = db.select({ suspended: tenants.suspended, status: tenants.status }).from(tenants).where(eq(tenants.id, params.tenantId)).get();
      if (row?.status === "provisioning") throw errValidation(`tenant ${tc.subdomain} is still provisioning — finish or remove its create-tenant run before setting its own domain`);
      if (row?.status === "offboarded" || row?.status === "purged") throw errValidation(`tenant ${tc.subdomain} is ${row.status} — nothing serves it, so there is no domain to set`);
      if (row?.suspended) throw errValidation(`tenant ${tc.subdomain} is suspended — its ingress is down, so its new host could never answer; resume it first`);
      if (tc.ownDomain !== params.previous) throw errValidation(`tenant ${tc.subdomain} has the own domain ${tc.ownDomain || "none"}, not ${params.previous || "none"} as this request says — it moved since; ask again`);
      if (params.ownDomain !== "" && tc.routing !== "path") throw errValidation(`tenant ${tc.subdomain} is on ${tc.routing} routing — an own domain serves every member under a path of it, so move the tenant to path routing first`);
      const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
      const zone = tenantZone(tc.subdomain, tc.stage, apex);
      if (params.ownDomain !== "") {
        if (params.ownDomain === apex || params.ownDomain.endsWith(`.${apex}`)) {
          throw errValidation(`${params.ownDomain} lies in the platform's own name space (${apex}) — an own domain is one the customer brings`);
        }
        // Every other LIVE tenant's own domain: equal, or one inside the other (a session cookie scoped
        // to the outer host would reach the inner one). An offboarded or purged tenant's is free again.
        const others = db
          .select({ subdomain: tenants.subdomain, ownDomain: tenants.ownDomain })
          .from(tenants)
          .where(and(ne(tenants.id, params.tenantId), ne(tenants.ownDomain, ""), notInArray(tenants.status, [...TENANT_SETTLED_STATUS])))
          .all();
        const clash = others.find((o) => o.ownDomain === params.ownDomain || o.ownDomain.endsWith(`.${params.ownDomain}`) || params.ownDomain.endsWith(`.${o.ownDomain}`));
        if (clash) throw errValidation(`${params.ownDomain} ${clash.ownDomain === params.ownDomain ? "is already" : "overlaps"} the own domain of tenant ${clash.subdomain} (${clash.ownDomain})`);
        // A cluster's own name, or a name below it, is the installation's.
        const cluster = db.select({ domain: clusters.domain }).from(clusters).all().find((c) => params.ownDomain === c.domain || params.ownDomain.endsWith(`.${c.domain}`));
        if (cluster) throw errValidation(`${params.ownDomain} lies under the cluster name ${cluster.domain} — an own domain is one the customer brings`);
      }
      const newHost = params.ownDomain || zone;
      const oldRecord = params.previous !== "" && params.previous !== params.ownDomain ? params.previous : null;
      const steps = tenantSetOwnDomainSteps(ports, params);
      return {
        kind: "tenant-set-own-domain",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary:
          `${params.previous === params.ownDomain ? "Re-apply" : `Move tenant ${tc.guid} from ${params.previous || zone} to`} ${newHost} (${tc.domain}, ${tc.stage}): ` +
          `${params.ownDomain ? `point ${params.ownDomain} at ${zone}, ` : ""}record it on the registration and the row, wait until ${tenantMemberUrl("path", tc.identityProvider, tc.stage, tc.subdomain, apex, params.ownDomain)}/ answers with a 2xx` +
          `${oldRecord ? `, then remove the record of ${oldRecord}` : ""}. The product's charts must serve ${newHost}, with its certificate, for the wait to end. ` +
          `Where this installation does not manage the DNS zone of ${params.ownDomain || "the domain"}, set its record (CNAME onto ${zone}) BEFORE approving: from the moment the domain is recorded, the tenant answers only there.`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => tenantSetOwnDomainSteps(ports, params),
    cleanups: (params) => [removeNewRecordCleanup(ports, params), restoreOwnDomainCleanup(ports, params.tenantId, params.previous)],
    // Refused once the previous domain's record, which this installation wrote, is gone: the tenant then
    // stands on the new host alone, and the abort would remove it. The zone's record is never removed.
    assertAbortable: async (params) => {
      if (params.previous === "" || params.previous === params.ownDomain || !ports.dns) return;
      let standing: string | null;
      try {
        standing = await ports.dns.readRecordContent({ name: params.previous, type: "CNAME" });
      } catch (e) {
        // A zone nobody here manages: this run never removed that record, so the abort takes nothing.
        if (e instanceof DnsZoneUnknownError) return;
        throw e;
      }
      if (standing === null) {
        throw errValidation(`${params.previous}, the previous own domain's record, is gone — the tenant stands on ${params.ownDomain || "its zone"} alone, and an abort would remove it. Retry the run instead.`);
      }
    },
  };
}
