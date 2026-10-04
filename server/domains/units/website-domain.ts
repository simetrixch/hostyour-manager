// A website's own domain, as the runs that add, move and remove a website handle it.
//
// A website of a tenant answers at `<domain>`, and `www.<domain>` redirects there, the way the tenant's
// own domain does (ownDomainHosts), as does each alias domain and its `www.`. Each host gets a CNAME onto the tenant's zone, written and booked
// by the same helpers tenant-set-own-domain uses, so a record in a zone the customer manages never has
// to change when the tenant moves. The hosts the tenant's own domain already holds belong to
// tenant-set-own-domain: a website served there writes and removes no record of its own.
import type { Cleanup, Step } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { loadTenantCluster, type TenantCluster } from "./lifecycle.ts";
import { aliasHosts, ownDomainHosts, tenantOwnHosts, tenantZone } from "#unit/shared/unit-host.ts";
import {
  provisionOwnDomainRecord, recordsToReplace, removeOwnDomainRecord, restoreReplacedRecords, waitForAnswer,
  type AnswerWaitPorts, type RecordPorts, type ReplacedRecord,
} from "./own-domain-records.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import { STAGE } from "../../../shared/enums.ts";

/** What the website steps read: the DNS provider, the zone's apex, and the probe with its wait. */
export type WebsiteDomainPorts = RecordPorts & Pick<TenantLifecyclePorts, "resolveUnitApex" | "registrations"> & AnswerWaitPorts;

/** The hosts a website answers at: `<domain>`, then `www.<domain>` and each alias domain with its
 *  `www.`, which redirect there. */
export function websiteHosts(domain: string, aliases: readonly string[] = []): string[] {
  const { ownDomain, ownDomainRedirects } = ownDomainHosts(domain);
  return [ownDomain, ...ownDomainRedirects, ...aliasHosts(aliases)];
}

/** The hosts of a website whose records a run writes and removes: every host the tenant's own domain
 *  does not already hold. */
export function websiteRecordHosts(domain: string, aliases: readonly string[], tenant: { ownDomain: string; ownDomainRedirects: readonly string[]; ownDomainAliases?: readonly string[] | undefined }): string[] {
  const held = new Set(tenantOwnHosts(tenant.ownDomain, tenant.ownDomainRedirects, tenant.ownDomainAliases));
  return websiteHosts(domain, aliases).filter((h) => !held.has(h));
}

/** Every host a website of this tenant answers at, off its registration: what a move of the tenant's own
 *  domain must leave standing. */
export async function tenantWebsiteHosts(registrations: Pick<TenantRegistrations, "readTenant">, tenant: { stage: Parameters<TenantRegistrations["readTenant"]>[0]; guid: string }): Promise<Set<string>> {
  const read = await registrations.readTenant(tenant.stage, tenant.guid);
  return new Set((read?.entry.apps ?? []).flatMap((a) => (a.domain ? websiteHosts(a.domain, a.aliases) : [])));
}

/** Every host a website of ANOTHER tenant answers at, at every stage, off the registrations: a domain is
 *  one name in DNS whatever stage its tenant stands at, so it serves one website. */
export async function otherTenantsWebsiteHosts(registrations: Pick<TenantRegistrations, "listTenantPointers">, guid: string): Promise<{ host: string; subdomain: string; guid: string }[]> {
  const hosts: { host: string; subdomain: string; guid: string }[] = [];
  for (const stage of STAGE) {
    for (const t of (await registrations.listTenantPointers(stage)).pointers) {
      if (t.guid === guid) continue;
      for (const a of t.apps) if (a.domain) hosts.push(...websiteHosts(a.domain, a.aliases).map((host) => ({ host, subdomain: t.subdomain, guid: t.guid })));
    }
  }
  return hosts;
}

/** The records standing at a website's `hosts` that its run replaces, read when the run is planned. */
export async function websiteRecordsToReplace(db: Db, ports: WebsiteDomainPorts, tc: TenantCluster, hosts: readonly string[], signal?: AbortSignal): Promise<ReplacedRecord[]> {
  if (hosts.length === 0) return [];
  const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
  return recordsToReplace(db, ports, tc.guid, tenantZone(tc.subdomain, tc.stage, apex), hosts, signal);
}

/** On abort: remove the records of `hosts`, where this installation wrote them for the tenant, and write
 *  back the records the run replaced there — except at a host the tenant still serves once the other
 *  cleanups ran: its own domain's, or a website's as the registration stands again (a move keeps the
 *  previous domain's records, which the restored website answers at). */
export function removeWebsiteRecordsCleanup(ports: WebsiteDomainPorts, tenantId: string, hosts: readonly string[], replacing: readonly ReplacedRecord[]): Cleanup {
  return {
    name: "remove-website-records",
    title: `Remove the DNS records of ${hosts.join(", ") || "no host"}${replacing.length ? ", and write back the records they replaced" : ""}`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, tenantId);
      const used = new Set([...tenantOwnHosts(tc.ownDomain, tc.ownDomainRedirects, tc.ownDomainAliases), ...(await tenantWebsiteHosts(ports.registrations, tc))]);
      for (const host of hosts) if (!used.has(host)) await removeOwnDomainRecord(ctx, ports, tc, host);
      await restoreReplacedRecords(ctx, ports, replacing.filter((r) => !used.has(r.name)));
    },
  };
}

/** Point every host of `hosts` at the tenant's zone, replacing the records the plan froze in `replacing`.
 *  An abort removes them again and writes the replaced records back. */
export function provisionWebsiteRecordsStep(ports: WebsiteDomainPorts, tenantId: string, hosts: readonly string[], replacing: readonly ReplacedRecord[]): Step {
  return {
    name: "provision-website-records",
    title: "Point the website's hosts at the tenant's zone",
    run: async (ctx) => {
      if (hosts.length === 0) {
        ctx.log("meta", "the website is served at the tenant's own domain, whose records tenant-set-own-domain holds — no record to write");
        return;
      }
      const tc = loadTenantCluster(ctx.db, tenantId);
      ctx.registerCleanup(removeWebsiteRecordsCleanup(ports, tenantId, hosts, replacing));
      const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
      for (const host of hosts) await provisionOwnDomainRecord(ctx, ports, tc, apex, host, replacing);
    },
  };
}

/** Wait until the website answers at `https://<domain>/`, and its `www.` and alias hosts redirect. The
 *  probe does not follow a redirect, so the site's own root may answer with one too (a language
 *  redirect), and anything below 400 is an answer. */
export async function waitForWebsite(ctx: Parameters<typeof waitForAnswer>[0], ports: WebsiteDomainPorts, domain: string, next: string, aliases: readonly string[] = []): Promise<void> {
  const [site, ...redirects] = websiteHosts(domain, aliases);
  const seen = await waitForAnswer(ctx, ports, `https://${site}/`, "an answer below 400", (s) => s >= 200 && s < 400, next);
  ctx.log("meta", `https://${site}/ answers (${seen})`);
  for (const host of redirects) {
    const redirect = await waitForAnswer(ctx, ports, `https://${host}/`, "a redirect", (s) => s >= 300 && s < 400, next);
    ctx.log("meta", `https://${host}/ redirects (${redirect})`);
  }
}
