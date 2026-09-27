// The records and the wait of a customer's own hosts: the tenant's own domain (tenant-set-own-domain)
// and a website's domain (website-domain.ts). Each host gets a CNAME onto the tenant's zone, entered
// into the book of DNS writes; a host in a zone nobody here manages is named for the operator to set.
import { and, ne, notInArray } from "drizzle-orm";
import type { StepCtx } from "../../executor/types.ts";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { errValidation } from "../../kernel/errors.ts";
import { clusters, tenants } from "../../db/schema/inventory.ts";
import type { Db } from "../../db/client.ts";
import { findDnsWrite, recordDnsWrite } from "../../db/dns-writes.ts";
import { DnsZoneUnknownError } from "../../adapters/dns/port.ts";
import type { TenantCluster, TenantLifecyclePorts } from "./lifecycle.ts";
import { isTenantRecord, removeBookedRecord, tenantZone } from "#unit/server/unit-dns.ts";
import { tenantOwnHosts as ownHosts } from "#unit/shared/unit-host.ts";
import { sleep } from "#unit/server/release-cycle.ts";
import type { PublicProbe } from "#unit/server/adapters/http-probe/port.ts";

/** What writing and removing a record reads: the installation's DNS provider, where one is configured. */
export type RecordPorts = Pick<TenantLifecyclePorts, "dns">;

/** What waiting for an answer reads: the probe, how long it asks, and how long it pauses between asks. */
export interface AnswerWaitPorts {
  probe: PublicProbe;
  routingWaitMs: number;
  routingPollMs: number;
}

/** Why `host` cannot be a customer's host of this tenant, or null: it lies in the platform's own name
 *  space or under a cluster's name, or it is, or overlaps, a host of another live tenant (one host
 *  carries one record, so it serves one tenant, and a session cookie scoped to an outer host would
 *  reach the inner one). An offboarded or purged tenant's hosts are free again. */
export function customerHostProblem(db: Db, tenantId: string, host: string, apex: string, websites: readonly { host: string; subdomain: string }[] = []): string | null {
  if (host === apex || host.endsWith(`.${apex}`)) return `${host} lies in the platform's own name space (${apex}) — a customer's domain is one the customer brings`;
  const cluster = db.select({ domain: clusters.domain }).from(clusters).all().map((c) => c.domain).find((d) => host === d || host.endsWith(`.${d}`));
  if (cluster) return `${host} lies under the cluster name ${cluster} — a customer's domain is one the customer brings`;
  const others = db
    .select({ subdomain: tenants.subdomain, ownDomain: tenants.ownDomain, ownDomainRedirects: tenants.ownDomainRedirects })
    .from(tenants)
    .where(and(ne(tenants.id, tenantId), ne(tenants.ownDomain, ""), notInArray(tenants.status, [...TENANT_SETTLED_STATUS])))
    .all();
  for (const o of others) {
    const theirs = ownHosts(o.ownDomain, o.ownDomainRedirects).find((h) => h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`));
    if (theirs) return `${host} ${theirs === host ? "is already" : "overlaps"} a host of tenant ${o.subdomain} (${theirs})`;
  }
  const website = websites.find((w) => w.host === host || w.host.endsWith(`.${host}`) || host.endsWith(`.${w.host}`));
  if (website) return `${host} ${website.host === host ? "is already" : "overlaps"} a website host of tenant ${website.subdomain} (${website.host})`;
  return null;
}

/** Point `domain` at the tenant's zone, where this installation's DNS provider manages the domain's
 *  zone, and enter the write into the book. Where it does not, say which record the operator sets. */
export async function provisionOwnDomainRecord(ctx: StepCtx, ports: RecordPorts, tc: TenantCluster, apex: string, domain: string): Promise<void> {
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

/** Remove `domain`'s record where this installation wrote it for this tenant (the book says so), while
 *  it still points where the book says. A record in a zone nobody here manages is the operator's to
 *  remove, and the run says so. */
export async function removeOwnDomainRecord(ctx: StepCtx, ports: RecordPorts, tc: TenantCluster, domain: string): Promise<void> {
  if (!(await removeBookedRecord(ctx, { dns: ports.dns, owner: { kind: "tenant", name: tc.guid }, recordName: domain }))) {
    ctx.log("meta", `${domain} is not recorded as tenant ${tc.guid}'s own record — if it points at the tenant, remove it at its provider`);
  }
}

/** Ask `url` until `accepts` takes its status, or fail at the deadline naming what was waited for. */
export async function waitForAnswer(ctx: StepCtx, ports: AnswerWaitPorts, url: string, wanted: string, accepts: (status: number) => boolean, next: string): Promise<string> {
  const deadline = Date.now() + ports.routingWaitMs;
  for (;;) {
    const seen = await ports.probe.probe(url, { signal: ctx.signal });
    if (seen.status !== null && accepts(seen.status)) return seen.detail;
    if (ctx.signal.aborted) throw errValidation(`the wait for ${url} was cancelled`);
    if (Date.now() >= deadline) {
      throw errValidation(
        `${url} did not answer with ${wanted} within ${Math.round(ports.routingWaitMs / 60_000)} minutes (last: ${seen.detail}) — ` +
        `its record, its certificate or the product's charts are not in place yet. ${next}`,
      );
    }
    ctx.log("meta", `${url} does not answer with ${wanted} yet (${seen.detail}); asking again in ${Math.round(ports.routingPollMs / 1000)}s`);
    await sleep(ports.routingPollMs, ctx.signal);
  }
}
