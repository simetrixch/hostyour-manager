import { z } from "zod";
import { and, eq, ne, notInArray } from "drizzle-orm";
import type { Cleanup, RunDefinition, Step } from "../../executor/types.ts";
import { publicFqdn } from "../../../shared/consumer.ts";
import { errInternal, errValidation } from "../../kernel/errors.ts";
import { tenants } from "../../db/schema/inventory.ts";
import type { Db } from "../../db/client.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { DnsZoneUnknownError } from "../../adapters/dns/port.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantCluster } from "./lifecycle.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { tenantMemberUrl, tenantZone } from "#unit/server/unit-dns.ts";
import { tenantOwnHosts as ownHosts } from "#unit/shared/unit-host.ts";
import type { TenantSetRoutingPorts } from "./tenant-routing.run.ts";
import { customerHostProblem, provisionOwnDomainRecord, recordsToReplace, removeOwnDomainRecord, replacementSentence, restoreReplacedRecords, waitForAnswer, ReplacedRecord } from "./own-domain-records.ts";
import { otherTenantsWebsiteHosts, tenantWebsiteHosts } from "./website-domain.ts";

/** What a failed wait tells the operator to do next. */
const OWN_DOMAIN_NEXT = "The previous hosts still stand: retry this step once they are, or abort the run to record the previous own domain again.";

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
// REDIRECT HOSTS: the operator may name further hosts (most often the other spelling of the domain,
// with or without `www.`) that the product's charts answer with a redirect to the own domain. Each gets
// the same record as the domain, and nothing derives them: only the operator knows which names the
// customer wants.
//
// THE WAIT BEFORE THE REMOVAL, as in tenant-set-routing: the previous hosts' records go only once the
// tenant's IdP answers a 2xx at the new host and every redirect host answers a redirect, and the wait
// and the removal are one step, so skipping a failed wait removes nothing. An abort records the
// previous hosts again and removes the new hosts' records where this run wrote them.

const ownDomain = z.union([z.literal(""), publicFqdn]);

export const TenantSetOwnDomainParams = z
  .object({
    tenantId: z.string().startsWith("tnt_"),
    /** The own domain to set, or "" to clear it and return the tenant to its zone. */
    ownDomain,
    /** The hosts that redirect to the own domain; empty without one. */
    ownDomainRedirects: z.array(publicFqdn).default([]),
    /** The own domain and redirect hosts the tenant had when this was asked for. The plan refuses a
     *  tenant that has moved since, and an abort records them again. */
    previous: ownDomain,
    previousRedirects: z.array(publicFqdn).default([]),
    /** The records standing at the new hosts that this run replaces, frozen by the plan; an abort
     *  writes them back. */
    replacing: z.array(ReplacedRecord).default([]),
    /** The subdomain of the tenant the operator confirms the new own domain lies under ("" for none):
     *  two tenants of one owner, where a cookie scoped to the outer host reaches the inner one. */
    nestsUnder: z.string().default(""),
    /** That tenant's id, resolved by the plan, and the one the row named before; the run records the
     *  first, and an abort the second. */
    nestsUnderTenantId: z.string().nullable().default(null),
    previousNestsUnder: z.string().nullable().default(null),
  })
  .superRefine((p, ctx) => {
    if (p.ownDomain === "" && p.ownDomainRedirects.length > 0) ctx.addIssue({ code: "custom", path: ["ownDomainRedirects"], message: "redirect hosts need an own domain to redirect to" });
    if (p.ownDomainRedirects.includes(p.ownDomain)) ctx.addIssue({ code: "custom", path: ["ownDomainRedirects"], message: "the own domain cannot redirect to itself" });
    if (new Set(p.ownDomainRedirects).size !== p.ownDomainRedirects.length) ctx.addIssue({ code: "custom", path: ["ownDomainRedirects"], message: "a redirect host is named twice" });
  });
export type TenantSetOwnDomainParams = z.infer<typeof TenantSetOwnDomainParams>;

/** The previous hosts this run takes the records of: those the new set no longer names. */
function retiredHosts(p: TenantSetOwnDomainParams): string[] {
  const kept = new Set(ownHosts(p.ownDomain, p.ownDomainRedirects));
  return ownHosts(p.previous, p.previousRedirects).filter((h) => !kept.has(h));
}

function sameHosts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");
}

export type TenantSetOwnDomainPorts = TenantSetRoutingPorts;

/** The host a tenant is reached at: its own domain, or its zone where it has none. */
function tenantHost(tc: TenantCluster, apex: string, domain: string): string {
  return domain || tenantZone(tc.subdomain, tc.stage, apex);
}

/** On abort: put the previous own domain and redirect hosts back on the registration and the row. */
function restoreOwnDomainCleanup(ports: TenantSetOwnDomainPorts, p: TenantSetOwnDomainParams): Cleanup {
  return {
    name: "restore-own-domain",
    title: `Record the previous own domain (${p.previous || "none"}) again`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, p.tenantId);
      const { commit } = await ports.registrations.setOwnDomain(tc.stage, tc.guid, p.previous, p.previousRedirects, ctx.runId);
      ctx.db.update(tenants).set({ ownDomain: p.previous, ownDomainRedirects: p.previousRedirects, nestsUnder: p.previousNestsUnder, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
      ctx.log("meta", `tenant ${tc.guid} own domain back to ${p.previous || "none"} (${commit})`);
    },
  };
}

/** On abort: remove the requested hosts' records — except those the tenant's recorded hosts name after
 *  all — and write back the records the run replaced at the hosts it removed. Runs after
 *  restore-own-domain (cleanups run in reverse order). */
function removeNewRecordCleanup(ports: TenantSetOwnDomainPorts, p: TenantSetOwnDomainParams): Cleanup {
  return {
    name: "remove-new-own-domain-record",
    title: `Remove the DNS records of ${ownHosts(p.ownDomain, p.ownDomainRedirects).join(", ") || "no domain"}, where the tenant does not use them`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, p.tenantId);
      const used = new Set([...ownHosts(tc.ownDomain, tc.ownDomainRedirects), ...(await tenantWebsiteHosts(ports.registrations, tc))]);
      for (const host of ownHosts(p.ownDomain, p.ownDomainRedirects)) {
        if (!used.has(host)) await removeOwnDomainRecord(ctx, ports, tc, host);
      }
      await restoreReplacedRecords(ctx, ports, p.replacing.filter((r) => !used.has(r.name)));
    },
  };
}

function tenantSetOwnDomainSteps(ports: TenantSetOwnDomainPorts, p: TenantSetOwnDomainParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    {
      name: "provision-own-domain-record",
      title: "Point the new own domain and its redirect hosts at the tenant's zone",
      run: async (ctx) => {
        if (p.ownDomain === "") {
          ctx.log("meta", "no own domain is set — the tenant returns to its zone, whose record stands");
          return;
        }
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        ctx.registerCleanup(removeNewRecordCleanup(ports, p));
        const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
        for (const host of ownHosts(p.ownDomain, p.ownDomainRedirects)) await provisionOwnDomainRecord(ctx, ports, tc, apex, host, p.replacing);
      },
    },
    {
      name: "write-own-domain",
      title: "Record the own domain on the tenant's registration and row",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        // The plan's facts, asked again: another run may have moved the tenant since it was planned.
        // A resume finds its own write already standing.
        const standsAt = (domain: string, redirects: readonly string[]): boolean => tc.ownDomain === domain && sameHosts(tc.ownDomainRedirects, redirects);
        if (!standsAt(p.previous, p.previousRedirects) && !standsAt(p.ownDomain, p.ownDomainRedirects)) {
          throw errValidation(`tenant ${tc.subdomain} has the own hosts ${ownHosts(tc.ownDomain, tc.ownDomainRedirects).join(", ") || "none"} now, not those of when this run was planned — plan it again`);
        }
        if (p.ownDomain !== "" && tc.routing !== "path") throw errValidation(`tenant ${tc.subdomain} is on ${tc.routing} routing now — an own domain needs path routing; plan it again`);
        ctx.registerCleanup(restoreOwnDomainCleanup(ports, p));
        const { commit } = await ports.registrations.setOwnDomain(tc.stage, tc.guid, p.ownDomain, p.ownDomainRedirects, ctx.runId);
        ctx.db.update(tenants).set({ ownDomain: p.ownDomain, ownDomainRedirects: p.ownDomainRedirects, nestsUnder: p.nestsUnderTenantId, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit });
        const via = p.ownDomainRedirects.length ? `, redirected from ${p.ownDomainRedirects.join(", ")}` : "";
        ctx.log("meta", `tenant ${tc.guid} own domain ${p.previous || "none"} → ${p.ownDomain || "none"}${via} (${commit}) — its charts serve it once the ArgoCD on ${tc.domain} syncs`);
      },
    },
    {
      name: "retire-previous-own-domain",
      title: "Wait until the tenant answers at its new hosts, then remove the previous hosts' records",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
        const url = `${tenantMemberUrl("path", tc.identityProvider, tc.stage, tc.subdomain, apex, p.ownDomain)}/`;
        const seen = await waitForAnswer(ctx, ports, url, "a 2xx", (s) => s >= 200 && s < 300, OWN_DOMAIN_NEXT);
        ctx.log("meta", `${url} answers (${seen}) — the tenant is served at ${tenantHost(tc, apex, p.ownDomain)}`);
        // The probe does not follow a redirect, so a redirect host answers with the 3xx itself.
        for (const host of p.ownDomainRedirects) {
          const redirect = await waitForAnswer(ctx, ports, `https://${host}/`, "a redirect", (s) => s >= 300 && s < 400, OWN_DOMAIN_NEXT);
          ctx.log("meta", `https://${host}/ redirects (${redirect})`);
        }
        // A host a website of the tenant still answers at stays: its records are the website's now.
        const websites = await tenantWebsiteHosts(ports.registrations, tc);
        for (const host of retiredHosts(p)) {
          if (websites.has(host)) ctx.log("meta", `${host} stays: a website of tenant ${tc.guid} answers there`);
          else await removeOwnDomainRecord(ctx, ports, tc, host);
        }
      },
    },
  ];
}

/** The tenant the operator confirms the new own domain lies under, with the host of it the domain lies
 *  below; null where the request names none. Refused where the tenant is not a live other tenant, or
 *  where the domain lies under none of its hosts, so a confirmation never stands for nothing. */
function resolveNesting(db: Db, p: TenantSetOwnDomainParams, websites: readonly { host: string; guid: string }[]): { tenantId: string; host: string } | null {
  if (p.nestsUnder === "") return null;
  if (p.ownDomain === "") throw errValidation(`no own domain is set, so it can lie under no tenant — leave "lies under tenant" empty`);
  const other = db
    .select({ id: tenants.id, guid: tenants.guid, ownDomain: tenants.ownDomain, ownDomainRedirects: tenants.ownDomainRedirects })
    .from(tenants)
    .where(and(eq(tenants.subdomain, p.nestsUnder), ne(tenants.id, p.tenantId), notInArray(tenants.status, [...TENANT_SETTLED_STATUS])))
    .get();
  if (!other) throw errValidation(`no other live tenant has the subdomain "${p.nestsUnder}" — name the tenant whose domain this one lies under`);
  const hosts = [...ownHosts(other.ownDomain, other.ownDomainRedirects), ...websites.filter((w) => w.guid === other.guid).map((w) => w.host)];
  const host = hosts.find((h) => p.ownDomain.endsWith(`.${h}`));
  if (!host) throw errValidation(`${p.ownDomain} lies under no host of tenant ${p.nestsUnder} (${hosts.join(", ") || "it has none"}), so there is nothing to confirm`);
  return { tenantId: other.id, host };
}

export function makeTenantSetOwnDomainDef(ports: TenantSetOwnDomainPorts): RunDefinition<TenantSetOwnDomainParams> {
  return {
    kind: "tenant-set-own-domain",
    paramsSchema: TenantSetOwnDomainParams,
    mutating: true,
    plan: () => {
      throw errInternal("tenant-set-own-domain is planned via planStream, not plan()");
    },
    // Streamed so the plan can freeze the records it replaces into the params, where the abort reads them.
    planStream: async (rawParams, ctx) => {
      const params = TenantSetOwnDomainParams.parse(rawParams);
      const db = ctx.db;
      const tc = loadTenantCluster(db, params.tenantId);
      const row = db.select({ suspended: tenants.suspended, status: tenants.status, nestsUnder: tenants.nestsUnder }).from(tenants).where(eq(tenants.id, params.tenantId)).get();
      if (row?.status === "provisioning") throw errValidation(`tenant ${tc.subdomain} is still provisioning — finish or remove its create-tenant run before setting its own domain`);
      if (row?.status === "offboarded" || row?.status === "purged") throw errValidation(`tenant ${tc.subdomain} is ${row.status} — nothing serves it, so there is no domain to set`);
      if (row?.suspended) throw errValidation(`tenant ${tc.subdomain} is suspended — its ingress is down, so its new host could never answer; resume it first`);
      if (tc.ownDomain !== params.previous || !sameHosts(tc.ownDomainRedirects, params.previousRedirects)) {
        throw errValidation(`tenant ${tc.subdomain} has the own hosts ${ownHosts(tc.ownDomain, tc.ownDomainRedirects).join(", ") || "none"}, not those this request says — it moved since; ask again`);
      }
      if (params.ownDomain !== "" && tc.routing !== "path") throw errValidation(`tenant ${tc.subdomain} is on ${tc.routing} routing — an own domain serves every member under a path of it, so move the tenant to path routing first`);
      const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
      const zone = tenantZone(tc.subdomain, tc.stage, apex);
      const websites = await otherTenantsWebsiteHosts(ports.registrations, tc.guid);
      const nesting = resolveNesting(db, params, websites);
      for (const host of ownHosts(params.ownDomain, params.ownDomainRedirects)) {
        const problem = customerHostProblem(db, params.tenantId, host, apex, websites, nesting?.tenantId ?? null);
        if (problem !== null) throw errValidation(problem);
      }
      const newHost = params.ownDomain || zone;
      const oldRecords = retiredHosts(params);
      const redirects = params.ownDomainRedirects;
      const replacing = await recordsToReplace(db, ports, tc.guid, zone, ownHosts(params.ownDomain, redirects), ctx.signal);
      const frozen: TenantSetOwnDomainParams = { ...params, replacing, nestsUnderTenantId: nesting?.tenantId ?? null, previousNestsUnder: row?.nestsUnder ?? null };
      const steps = tenantSetOwnDomainSteps(ports, frozen);
      return { outcome: "planned", params: frozen, plan: {
        kind: "tenant-set-own-domain",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary:
          `${params.previous === params.ownDomain ? "Re-apply" : `Move tenant ${tc.guid} from ${params.previous || zone} to`} ${newHost} (${tc.domain}, ${tc.stage}): ` +
          `${params.ownDomain ? `point ${ownHosts(params.ownDomain, redirects).join(", ")} at ${zone}, ` : ""}record it on the registration and the row, wait until ${tenantMemberUrl("path", tc.identityProvider, tc.stage, tc.subdomain, apex, params.ownDomain)}/ answers with a 2xx` +
          `${redirects.length ? ` and ${redirects.map((h) => `https://${h}/`).join(", ")} with a redirect` : ""}` +
          `${oldRecords.length ? `, then remove the records of ${oldRecords.join(", ")}` : ""}. The product's charts must serve ${newHost}${redirects.length ? " and its redirect hosts" : ""}, with certificates, for the wait to end. ` +
          `Where this installation does not manage the DNS zone of a host, set its record (CNAME onto ${zone}) BEFORE approving: from the moment the domain is recorded, the tenant answers only there.` +
          `${params.previous === params.ownDomain ? "" : " Its identity provider moves with its host, so every user of the tenant signs in once more."}${replacementSentence(replacing)}` +
          `${nesting ? ` ${params.ownDomain} lies under ${nesting.host} of tenant ${params.nestsUnder}, as the operator confirms here: a session cookie that tenant scopes to ${nesting.host} reaches this tenant's hosts.` : ""}`,
        steps: steps.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: tenantLocks(ports.registrations),
        warnings: [],
        requiredSecrets: [],
      } };
    },
    steps: (params) => tenantSetOwnDomainSteps(ports, params),
    cleanups: (params) => [removeNewRecordCleanup(ports, params), restoreOwnDomainCleanup(ports, params)],
    // Refused once a previous host's record, which this installation wrote, is gone: the tenant then
    // stands on the new hosts alone, and the abort would remove them. The zone's record is never removed.
    assertAbortable: async (params) => {
      if (!ports.dns) return;
      for (const host of retiredHosts(params)) {
        let standing: string | null;
        try {
          standing = await ports.dns.readRecordContent({ name: host, type: "CNAME" });
        } catch (e) {
          // A zone nobody here manages: this run never removed that record, so the abort takes nothing.
          if (e instanceof DnsZoneUnknownError) continue;
          throw e;
        }
        if (standing === null) {
          throw errValidation(`${host}, a previous host's record, is gone — the tenant stands on ${params.ownDomain || "its zone"} alone, and an abort would remove it. Retry the run instead.`);
        }
      }
    },
  };
}
