import { z } from "zod";
import { and, eq, ne, notInArray } from "drizzle-orm";
import type { Cleanup, RunDefinition, Step } from "../../executor/types.ts";
import { publicFqdn } from "../../../shared/consumer.ts";
import { errInternal, errValidation } from "../../kernel/errors.ts";
import { tenants } from "../../db/schema/inventory.ts";
import type { Db } from "../../db/client.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { DnsZoneUnknownError } from "../../adapters/dns/port.ts";
import { attestTenantTargetStep, loadTenantCluster, type TenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { refuseOffStageHosts } from "./stage-hosts.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { tenantZone } from "#unit/server/unit-dns.ts";
import { aliasHosts, tenantOwnHosts as ownHosts } from "#unit/shared/unit-host.ts";
import type { PublicProbe } from "#unit/server/adapters/http-probe/port.ts";
import {
  checkMailRecordsStep, customerHostProblem, mailRecordHashes, mailRecordSentence, provisionOwnDomainRecord, recordsToReplace, removeOwnDomainRecord,
  replacementSentence, restoreReplacedRecords, waitForAnswer, MailRecordHash, ReplacedRecord,
} from "./own-domain-records.ts";

/** What a failed wait tells the operator to do next. */
const OWN_DOMAIN_NEXT = "The previous hosts still stand: retry this step once they are, or abort the run to record the previous own domain again.";

// `tenant-set-own-domain` — set, switch or clear the ONE own domain of a standing tenant.
//
// WHY IT EXISTS. A tenant is reached at its zone `<subdomain>.<stage apex>`. A customer may bring an
// own domain instead, which replaces the zone as the tenant's one host: every member stands under a
// path of it, and the zone's own record stays, because the product's charts keep the identity
// provider's key file on the zone. The customer may switch the domain later.
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
// ALIAS DOMAINS: each alias, typed without `www.`, answers with its `www.` with a PERMANENT redirect to
// the own domain, where a redirect host's is temporary. A MOVE KEEPS WHERE THE TENANT STOOD: moving
// from one own domain to another adds every previous host, without its `www.`, to the aliases, so links
// and bookmarks to the old name keep working. Only a later run that drops an alias removes its records.
// A domain that is an alias now cannot become the own domain in the same run: a browser that cached
// its permanent redirect would loop; drop the alias first.
//
// THE MAIL RECORDS BESIDE THE HOSTS: the run writes only CNAME records, and the plan hashes the MX, SPF,
// DMARC and autodiscover records at each host's domain; the run refuses to start where one changed.
//
// THE WAIT BEFORE THE REMOVAL: the previous hosts' records go only once the
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
    /** The alias domains to set, each without `www.`, and the ones the tenant had. */
    ownDomainAliases: z.array(publicFqdn).default([]),
    previousAliases: z.array(publicFqdn).default([]),
    /** The records standing at the new hosts that this run replaces, frozen by the plan; an abort
     *  writes them back. */
    replacing: z.array(ReplacedRecord).default([]),
    /** The mail records beside the hosts the run writes or removes, hashed by the plan. */
    mailRecords: z.array(MailRecordHash).default([]),
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
    if (p.ownDomain === "" && p.ownDomainAliases.length > 0) ctx.addIssue({ code: "custom", path: ["ownDomainAliases"], message: "alias domains need an own domain to redirect to" });
    if (new Set(p.ownDomainAliases).size !== p.ownDomainAliases.length) ctx.addIssue({ code: "custom", path: ["ownDomainAliases"], message: "an alias domain is named twice" });
    const held = new Set([p.ownDomain, ...p.ownDomainRedirects]);
    for (const host of aliasHosts(p.ownDomainAliases)) {
      if (held.has(host)) ctx.addIssue({ code: "custom", path: ["ownDomainAliases"], message: `${host} is already the own domain or a redirect host — an alias names another domain` });
    }
  });
export type TenantSetOwnDomainParams = z.infer<typeof TenantSetOwnDomainParams>;

/** Every own host the run asks for, and every one the tenant had. */
const hostsOf = (p: TenantSetOwnDomainParams): string[] => ownHosts(p.ownDomain, p.ownDomainRedirects, p.ownDomainAliases);
const previousHostsOf = (p: TenantSetOwnDomainParams): string[] => ownHosts(p.previous, p.previousRedirects, p.previousAliases);
/** Every own host the tenant's row has now. */
const standingHosts = (tc: Pick<TenantCluster, "ownDomain" | "ownDomainRedirects" | "ownDomainAliases">): string[] => ownHosts(tc.ownDomain, tc.ownDomainRedirects, tc.ownDomainAliases);

/** The previous hosts this run takes the records of: those the new set no longer names. */
function retiredHosts(p: TenantSetOwnDomainParams): string[] {
  const kept = new Set(hostsOf(p));
  return previousHostsOf(p).filter((h) => !kept.has(h));
}

function sameHosts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");
}

export type TenantSetOwnDomainPorts = TenantLifecyclePorts & {
  /** Reads the tenant's IdP from the outside — the probe verify-quiesced reads a quiesced unit with. */
  probe: PublicProbe;
  /** How long the wait asks before it fails the run, and how long it pauses between two asks. */
  answerWaitMs: number;
  answerPollMs: number;
};

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
      const { commit } = await ports.registrations.setOwnDomain(tc.stage, tc.guid, p.previous, p.previousRedirects, p.previousAliases, ctx.runId);
      ctx.db.update(tenants).set({ ownDomain: p.previous, ownDomainRedirects: p.previousRedirects, ownDomainAliases: p.previousAliases, nestsUnder: p.previousNestsUnder, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
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
    title: `Remove the DNS records of ${hostsOf(p).join(", ") || "no domain"}, where the tenant does not use them`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, p.tenantId);
      const used = new Set(standingHosts(tc));
      for (const host of hostsOf(p)) {
        if (!used.has(host)) await removeOwnDomainRecord(ctx, ports, tc, host);
      }
      await restoreReplacedRecords(ctx, ports, p.replacing.filter((r) => !used.has(r.name)));
    },
  };
}

function tenantSetOwnDomainSteps(ports: TenantSetOwnDomainPorts, p: TenantSetOwnDomainParams): Step[] {
  return [
    attestTenantTargetStep(ports, p.tenantId),
    checkMailRecordsStep(ports, p.mailRecords),
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
        for (const host of hostsOf(p)) await provisionOwnDomainRecord(ctx, ports, tc, apex, host, p.replacing);
      },
    },
    {
      name: "write-own-domain",
      title: "Record the own domain on the tenant's registration and row",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        // The plan's facts, asked again: another run may have moved the tenant since it was planned.
        // A resume finds its own write already standing.
        const standsAt = (domain: string, redirects: readonly string[], aliases: readonly string[]): boolean =>
          tc.ownDomain === domain && sameHosts(tc.ownDomainRedirects, redirects) && sameHosts(tc.ownDomainAliases, aliases);
        if (!standsAt(p.previous, p.previousRedirects, p.previousAliases) && !standsAt(p.ownDomain, p.ownDomainRedirects, p.ownDomainAliases)) {
          throw errValidation(`tenant ${tc.subdomain} has the own hosts ${standingHosts(tc).join(", ") || "none"} now, not those of when this run was planned — plan it again`);
        }
        ctx.registerCleanup(restoreOwnDomainCleanup(ports, p));
        const { commit } = await ports.registrations.setOwnDomain(tc.stage, tc.guid, p.ownDomain, p.ownDomainRedirects, p.ownDomainAliases, ctx.runId);
        ctx.db.update(tenants).set({ ownDomain: p.ownDomain, ownDomainRedirects: p.ownDomainRedirects, ownDomainAliases: p.ownDomainAliases, nestsUnder: p.nestsUnderTenantId, lastRunId: ctx.runId, updatedAt: new Date() }).where(eq(tenants.id, p.tenantId)).run();
        ctx.checkpoint({ commit });
        const via = p.ownDomainRedirects.length || p.ownDomainAliases.length ? `, redirected from ${[...p.ownDomainRedirects, ...aliasHosts(p.ownDomainAliases)].join(", ")}` : "";
        ctx.log("meta", `tenant ${tc.guid} own domain ${p.previous || "none"} → ${p.ownDomain || "none"}${via} (${commit}) — its charts serve it once the ArgoCD on ${tc.domain} syncs`);
      },
    },
    {
      name: "retire-previous-own-domain",
      title: "Wait until the tenant answers at its new hosts, then remove the previous hosts' records",
      run: async (ctx) => {
        const tc = loadTenantCluster(ctx.db, p.tenantId);
        const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
        // The tenant web server, a standing member of every tenant, answers /health at the host's root.
        const url = `https://${tenantHost(tc, apex, p.ownDomain)}/health`;
        const seen = await waitForAnswer(ctx, ports, url, "a 2xx", (s) => s >= 200 && s < 300, OWN_DOMAIN_NEXT);
        ctx.log("meta", `${url} answers (${seen}) — the tenant is served at ${tenantHost(tc, apex, p.ownDomain)}`);
        // The probe does not follow a redirect, so a redirect host answers with the 3xx itself.
        for (const host of [...p.ownDomainRedirects, ...aliasHosts(p.ownDomainAliases)]) {
          const redirect = await waitForAnswer(ctx, ports, `https://${host}/`, "a redirect", (s) => s >= 300 && s < 400, OWN_DOMAIN_NEXT);
          ctx.log("meta", `https://${host}/ redirects (${redirect})`);
        }
        for (const host of retiredHosts(p)) await removeOwnDomainRecord(ctx, ports, tc, host);
      },
    },
  ];
}

/** The tenant the operator confirms the new own domain lies under, with the host of it the domain lies
 *  below; null where the request names none. Refused where the tenant is not a live other tenant, or
 *  where the domain lies under none of its hosts, so a confirmation never stands for nothing. */
function resolveNesting(db: Db, p: TenantSetOwnDomainParams): { tenantId: string; host: string } | null {
  if (p.nestsUnder === "") return null;
  if (p.ownDomain === "") throw errValidation(`no own domain is set, so it can lie under no tenant — leave "lies under tenant" empty`);
  const other = db
    .select({ id: tenants.id, guid: tenants.guid, ownDomain: tenants.ownDomain, ownDomainRedirects: tenants.ownDomainRedirects, ownDomainAliases: tenants.ownDomainAliases })
    .from(tenants)
    .where(and(eq(tenants.subdomain, p.nestsUnder), ne(tenants.id, p.tenantId), notInArray(tenants.status, [...TENANT_SETTLED_STATUS])))
    .get();
  if (!other) throw errValidation(`no other live tenant has the subdomain "${p.nestsUnder}" — name the tenant whose domain this one lies under`);
  const hosts = standingHosts(other);
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
      // A browser may have cached an alias's permanent redirect onto the previous domain, which this
      // run retires: that alias would lead nowhere as the own domain.
      if (params.ownDomain !== params.previous && params.previousAliases.includes(params.ownDomain)) {
        throw errValidation(`${params.ownDomain} is an alias of this tenant, whose permanent redirect a browser may have cached — drop the alias in one run, then make it the own domain in another`);
      }
      const row = db.select({ suspended: tenants.suspended, status: tenants.status, nestsUnder: tenants.nestsUnder }).from(tenants).where(eq(tenants.id, params.tenantId)).get();
      if (row?.status === "provisioning") throw errValidation(`tenant ${tc.subdomain} is still provisioning — finish or remove its create-tenant run before setting its own domain`);
      if (row?.status === "offboarded" || row?.status === "purged") throw errValidation(`tenant ${tc.subdomain} is ${row.status} — nothing serves it, so there is no domain to set`);
      if (row?.suspended) throw errValidation(`tenant ${tc.subdomain} is suspended — its ingress is down, so its new host could never answer; resume it first`);
      if (tc.ownDomain !== params.previous || !sameHosts(tc.ownDomainRedirects, params.previousRedirects) || !sameHosts(tc.ownDomainAliases, params.previousAliases)) {
        throw errValidation(`tenant ${tc.subdomain} has the own hosts ${standingHosts(tc).join(", ") || "none"}, not those this request says — it moved since; ask again`);
      }
      const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
      const zone = tenantZone(tc.subdomain, tc.stage, apex);
      const nesting = resolveNesting(db, params);
      // Only a host the move claims: one the tenant does not hold already. A host it holds stood as this
      // tenant's; judged again, an old-shape name under the tenant's own host at another stage would
      // refuse the very run that keeps it.
      const held = new Set(previousHostsOf(params));
      for (const host of hostsOf(params).filter((h) => !held.has(h))) {
        const problem = customerHostProblem(db, params.tenantId, host, apex, nesting?.tenantId ?? null);
        if (problem !== null) throw errValidation(problem);
      }
      // Only what is typed now: the domain where it changes, and an alias added. An alias the tenant
      // has already, and one dropped, are not judged.
      const typed = [...(params.ownDomain && params.ownDomain !== params.previous ? [params.ownDomain] : []), ...params.ownDomainAliases.filter((a) => a !== params.previous && !params.previousAliases.includes(a))];
      await refuseOffStageHosts(ports.dns, typed, tc.stage, ctx);
      const newHost = params.ownDomain || zone;
      const oldRecords = retiredHosts(params);
      const redirects = [...params.ownDomainRedirects, ...aliasHosts(params.ownDomainAliases)];
      const replacing = await recordsToReplace(db, ports, tc.guid, zone, hostsOf(params), ctx.signal);
      const mailRecords = await mailRecordHashes(ports, [...hostsOf(params), ...oldRecords], ctx.signal);
      const frozen: TenantSetOwnDomainParams = { ...params, replacing, mailRecords, nestsUnderTenantId: nesting?.tenantId ?? null, previousNestsUnder: row?.nestsUnder ?? null };
      const steps = tenantSetOwnDomainSteps(ports, frozen);
      return { outcome: "planned", params: frozen, plan: {
        kind: "tenant-set-own-domain",
        targetKind: "tenant",
        targetId: params.tenantId,
        summary:
          `${params.previous === params.ownDomain ? "Re-apply" : `Move tenant ${tc.guid} from ${params.previous || zone} to`} ${newHost} (${tc.domain}, ${tc.stage}): ` +
          `${params.ownDomain ? `point ${hostsOf(params).join(", ")} at ${zone}, ` : ""}record it on the registration and the row, wait until https://${newHost}/health answers with a 2xx` +
          `${redirects.length ? ` and ${redirects.map((h) => `https://${h}/`).join(", ")} with a redirect` : ""}` +
          `${oldRecords.length ? `, then remove the records of ${oldRecords.join(", ")}` : ""}. The product's charts must serve ${newHost}${redirects.length ? " and its redirect hosts" : ""}, with certificates, for the wait to end. ` +
          `Where this installation does not manage the DNS zone of a host, set its record (CNAME onto ${zone}) BEFORE approving: from the moment the domain is recorded, the tenant answers only there.` +
          `${params.previous === params.ownDomain ? "" : " Its identity provider moves with its host, so every user of the tenant signs in once more."}${replacementSentence(replacing)}${mailRecordSentence(mailRecords)}` +
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
