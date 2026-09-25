// The DNS inventory: every record this installation is responsible for at the DNS provider, with
// what stands there now — a consumer's host at every stage, a tenant's wildcard, the mail records
// of a sender domain — DERIVED from the state that does exist and then READ, name by name, at the
// provider. The book of DNS writes (db/dns-writes.ts) is the other list, and the DNS page shows it
// first: it carries only what a run of THIS Manager inserted or updated, so it cannot answer for a
// record an earlier installation wrote, which is exactly the leftover this inventory exists to name.
//
// WHY DERIVED AND NOT LISTED. The provider port can upsert, delete and read ONE record; it cannot
// list a zone, and a zone listing would anyway answer with records nobody here wrote (the
// installer's, the customer's own mail service). What this installation OWNS is exactly what its
// registrations and its cluster rows say it owns, so that is where the list comes from and the
// provider only ever answers "what is at this name".
//
// WHAT IS EXPECTED. A unit's record carries the address of the cluster it stands on, read off THAT
// CLUSTER'S own A record — the one authority for where a cluster is reachable, the same reading
// provision-dns makes before it writes (server/domains/units/unit-dns.ts). A record carrying
// anything else is not a mistake to be silently corrected here: it is what an installation that is
// gone left behind, and naming it is the whole point of this page.
//
// THE MAIL ROWS ARE THE MAIL PAGE'S OWN, measured at PUBLIC resolvers rather than at the provider —
// the records live in a zone somebody else may edit, so what receivers find is the only true answer
// about them (server/domains/mail/mail-dns.ts states that rule). They are carried in here verbatim
// so the two pages can never disagree about one record, and only the three this platform publishes
// are removable: the sender domain's own address record is the installer's, and the PTR is set
// where the egress address is rented.
//
// Boundary: this domain imports no other domain (the law in .dependency-cruiser.cjs), so the
// registrations, the tenant registrations and the mail measurement arrive as FUNCTIONS bound at the
// composition root (server/boot/wire.ts).
import type { Db } from "../../db/client.ts";
import { clusters } from "../../db/schema/inventory.ts";
import { DnsZoneUnknownError, type DnsProvider } from "../../adapters/dns/port.ts";
import { STAGE, type MemberRouting, type Stage } from "../../../shared/enums.ts";
import { consumerUnitHost, tenantOwnHosts, tenantRecordName, tenantZone } from "#unit/shared/unit-host.ts";
import type { MailDnsRecord, MailDnsRow, MailDnsView } from "../../../shared/mail.ts";
import type { DnsInventoryView, DnsOwner, DnsRecordRow, DnsRowType } from "../../../shared/dns.ts";

export interface DnsInventoryDeps {
  /** The cluster rows: one record name is composed per unit PER CLUSTER, and each cluster's own
   *  address is what its units' records must carry. */
  db: Db;
  /** The provider every unit row is read at. Absent on a manager with no DNS token — the unit rows
   *  are then not listed at all, because a row without a reading would state a verdict nobody took. */
  dns?: DnsProvider;
  /** Every consumer registered at one stage on one cluster, with the host LABEL it stands on (the
   *  registration's `host`, never the name). */
  /** The consumers registered on a cluster, named by the cluster's name, at one stage. */
  consumers?: (cluster: string, stage: Stage) => Promise<{ name: string; host: string }[]>;
  /** Every tenant registered at one stage, with its subdomain, the routing its record is named by
   *  (the wildcard or the zone) and the short name of the cluster it stands on. */
  tenants?: (stage: Stage) => Promise<{ subdomain: string; routing: MemberRouting; ownDomain: string; ownDomainRedirects: string[]; cluster: string }[]>;
  /** The public apex a cluster's units serve under at one stage (`global.unitApex` off its values
   *  chain) — the same resolution the tenant surface makes. */
  unitApex?: (domain: string, stage: Stage) => Promise<string>;
  /** The mail DNS of the installation as the Mail page measures it. */
  mail?: () => Promise<MailDnsView>;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Which of the five mail records this platform PUBLISHES, and is therefore able to take back. */
const MAIL_PUBLISHED: ReadonlySet<MailDnsRecord> = new Set<MailDnsRecord>(["spf", "dkim", "dmarc"]);

/** The type each mail record stands as. The address record is the installer's A record and the
 *  reverse DNS is a PTR at the hosting provider, which is why neither is removable below. */
const MAIL_ROW_TYPE: Record<MailDnsRecord, DnsRowType> = { spf: "TXT", a: "A", dkim: "TXT", dmarc: "TXT", ptr: "PTR" };

/** The reading of ONE unit record: what stands at the name, judged against the FQDN of its cluster,
 *  which the unit's CNAME must name. An address record standing where the CNAME belongs is the row
 *  as what it is — an absence would hide a host that answers. Removable without exception: whatever
 *  stands under a unit's host is that unit's record, and taking it back is what offboard does anyway. */
async function unitRow(dns: DnsProvider, owner: DnsOwner, name: string, cluster: string): Promise<DnsRecordRow> {
  const named = await dns.readRecordContent({ name, type: "CNAME" });
  const address = named === null ? await dns.readRecordContent({ name, type: "A" }) : null;
  const found = address ?? named;
  return {
    owner,
    name,
    type: address === null ? "CNAME" : "A",
    expected: cluster,
    found,
    verdict: found === null ? "absent" : address === null && named === cluster ? "standing" : "other",
    removable: true,
  };
}

/** One row of the Mail page as a row of this inventory: the same name, the same sentence for what
 *  must stand there and the same reading, with the verdict spelled in this page's three words. */
function mailRow(domain: string, row: MailDnsRow): DnsRecordRow {
  const published = MAIL_PUBLISHED.has(row.record);
  return {
    owner: { kind: published ? "mail" : "installer", name: domain },
    name: row.name,
    type: MAIL_ROW_TYPE[row.record],
    record: row.record,
    expected: row.expected,
    found: row.found,
    verdict: row.found === null ? "absent" : row.ok ? "standing" : "other",
    removable: published,
  };
}

/** The unit records of one cluster at one stage: every consumer's host and every tenant's record,
 *  composed by the one composer of each name (plugins/unit/shared/unit-host.ts) and read at the provider. */
async function unitRowsOf(
  deps: Required<Pick<DnsInventoryDeps, "dns" | "consumers" | "unitApex">>,
  cluster: { domain: string; name: string },
  stage: Stage,
  tenants: { subdomain: string; routing: MemberRouting; ownDomain: string; ownDomainRedirects: string[]; cluster: string }[],
): Promise<DnsRecordRow[]> {
  const { domain } = cluster;
  const apex = await deps.unitApex(domain, stage);
  const rows: DnsRecordRow[] = [];
  for (const consumer of await deps.consumers(cluster.name, stage)) {
    rows.push(await unitRow(deps.dns, { kind: "consumer", name: consumer.name, stage }, consumerUnitHost(consumer.host, stage, apex), domain));
  }
  for (const { subdomain, routing, ownDomain, ownDomainRedirects } of tenants.filter((t) => t.cluster === cluster.name)) {
    rows.push(await unitRow(deps.dns, { kind: "tenant", name: subdomain, stage }, tenantRecordName(routing, subdomain, stage, apex), domain));
    // The own domain's and its redirect hosts' records point at the tenant's zone, not at the cluster.
    // Listed only where this installation's provider manages their zone: a record in a customer's zone
    // is not ours to show.
    for (const host of tenantOwnHosts(ownDomain, ownDomainRedirects)) {
      try {
        rows.push(await unitRow(deps.dns, { kind: "tenant", name: subdomain, stage }, host, tenantZone(subdomain, stage, apex)));
      } catch (e) {
        if (!(e instanceof DnsZoneUnknownError)) throw e;
      }
    }
  }
  return rows;
}

/** Every record this installation is responsible for, read now. Fail-SOFT per source: a stage whose
 *  registrations cannot be read and a mail measurement that has no master each leave a sentence in
 *  `skipped` rather than emptying the page — an inventory that quietly listed fewer records would
 *  read as a zone with nothing left in it, which is the one wrong answer this surface can give. */
export async function readDnsInventory(deps: DnsInventoryDeps): Promise<DnsInventoryView> {
  const rows: DnsRecordRow[] = [];
  const skipped: string[] = [];
  const { dns, consumers, tenants, unitApex } = deps;
  if (dns && consumers && tenants && unitApex) {
    const clusterRows = deps.db.select({ domain: clusters.domain, name: clusters.name }).from(clusters).all();
    for (const stage of STAGE) {
      let tenantsAt: { subdomain: string; routing: MemberRouting; ownDomain: string; ownDomainRedirects: string[]; cluster: string }[] = [];
      try {
        tenantsAt = await tenants(stage);
      } catch (e) {
        skipped.push(`the tenant registrations at ${stage} could not be read, so no tenant record of that stage is listed: ${messageOf(e)}`);
      }
      for (const cluster of clusterRows) {
        try {
          rows.push(...(await unitRowsOf({ dns, consumers, unitApex }, cluster, stage, tenantsAt)));
        } catch (e) {
          skipped.push(`the ${stage} records of ${cluster.domain} could not be listed: ${messageOf(e)}`);
        }
      }
    }
  } else {
    skipped.push(
      "the consumer and tenant records are not listed: this manager has no DNS provider or no registrations wired, " +
        "and both are needed to say which unit records this installation wrote and what stands at them",
    );
  }
  if (deps.mail) {
    try {
      const view = await deps.mail();
      for (const domain of view.domains) for (const row of domain.rows) rows.push(mailRow(domain.domain, row));
    } catch (e) {
      skipped.push(`the mail records are not listed: ${messageOf(e)}`);
    }
  }
  return { rows, skipped, readAt: new Date().toISOString() };
}
