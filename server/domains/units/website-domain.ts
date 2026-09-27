// A website's own domain, as the runs that add, move and remove a website handle it (hostyour-manager#308).
//
// A website of a tenant answers at `www.<domain>`, and `<domain>` redirects there, the way the tenant's
// own domain does (ownDomainHosts). Each host gets a CNAME onto the tenant's zone, written and booked
// by the same helpers tenant-set-own-domain uses, so a record in a zone the customer manages never has
// to change when the tenant moves. The hosts the tenant's own domain already holds belong to
// tenant-set-own-domain: a website served there writes and removes no record of its own.
import type { Cleanup, Step } from "../../executor/types.ts";
import { loadTenantCluster } from "./lifecycle.ts";
import { ownDomainHosts, tenantOwnHosts } from "#unit/shared/unit-host.ts";
import { provisionOwnDomainRecord, removeOwnDomainRecord, waitForAnswer, type AnswerWaitPorts, type RecordPorts } from "./own-domain-records.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";

/** What the website steps read: the DNS provider, the zone's apex, and the probe with its wait. */
export type WebsiteDomainPorts = RecordPorts & Pick<TenantLifecyclePorts, "resolveUnitApex"> & AnswerWaitPorts;

/** The hosts a website answers at: `www.<domain>`, then `<domain>`, which redirects there. */
export function websiteHosts(domain: string): string[] {
  const { ownDomain, ownDomainRedirects } = ownDomainHosts(domain);
  return [ownDomain, ...ownDomainRedirects];
}

/** The hosts of a website whose records a run writes and removes: every host the tenant's own domain
 *  does not already hold. */
export function websiteRecordHosts(domain: string, tenant: { ownDomain: string; ownDomainRedirects: readonly string[] }): string[] {
  const held = new Set(tenantOwnHosts(tenant.ownDomain, tenant.ownDomainRedirects));
  return websiteHosts(domain).filter((h) => !held.has(h));
}

/** On abort: remove the records of `hosts`, where this installation wrote them for the tenant. */
export function removeWebsiteRecordsCleanup(ports: WebsiteDomainPorts, tenantId: string, hosts: readonly string[]): Cleanup {
  return {
    name: "remove-website-records",
    title: `Remove the DNS records of ${hosts.join(", ") || "no host"}`,
    run: async (ctx) => {
      const tc = loadTenantCluster(ctx.db, tenantId);
      for (const host of hosts) await removeOwnDomainRecord(ctx, ports, tc, host);
    },
  };
}

/** Point every host of `hosts` at the tenant's zone. An abort removes them again. */
export function provisionWebsiteRecordsStep(ports: WebsiteDomainPorts, tenantId: string, hosts: readonly string[]): Step {
  return {
    name: "provision-website-records",
    title: "Point the website's hosts at the tenant's zone",
    run: async (ctx) => {
      if (hosts.length === 0) {
        ctx.log("meta", "the website is served at the tenant's own domain, whose records tenant-set-own-domain holds — no record to write");
        return;
      }
      const tc = loadTenantCluster(ctx.db, tenantId);
      ctx.registerCleanup(removeWebsiteRecordsCleanup(ports, tenantId, hosts));
      const apex = await ports.resolveUnitApex(tc.domain, tc.stage);
      for (const host of hosts) await provisionOwnDomainRecord(ctx, ports, tc, apex, host);
    },
  };
}

/** Wait until the website answers at `https://www.<domain>/`, and `https://<domain>/` redirects. The
 *  probe does not follow a redirect, so the site's own root may answer with one too (a language
 *  redirect), and anything below 400 is an answer. */
export async function waitForWebsite(ctx: Parameters<typeof waitForAnswer>[0], ports: WebsiteDomainPorts, domain: string): Promise<void> {
  const [site, ...redirects] = websiteHosts(domain);
  const seen = await waitForAnswer(ctx, ports, `https://${site}/`, "an answer below 400", (s) => s >= 200 && s < 400);
  ctx.log("meta", `https://${site}/ answers (${seen})`);
  for (const host of redirects) {
    const redirect = await waitForAnswer(ctx, ports, `https://${host}/`, "a redirect", (s) => s >= 300 && s < 400);
    ctx.log("meta", `https://${host}/ redirects (${redirect})`);
  }
}
