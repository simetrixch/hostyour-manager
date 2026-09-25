import { z } from "zod";
import type { RunDefinition, Step } from "../../../executor/types.ts";
import { ATTEST_TARGET_STEP } from "../../../executor/guards.ts";
import { errValidation } from "../../../kernel/errors.ts";
import type { DnsRecordRow } from "../../../../shared/dns.ts";
import { deleteRecord, ownedRecords, requireDnsProvider, type DnsRecordPorts, type RemovableRecordRow } from "#unit/server/dns/dns-record.kit.ts";

// mail-dns-unpublish: the inverse of mail-dns-publish — take the mail records of ONE sender domain
// of this installation back out of the zone. Three records go, in one act: the domain's SPF, the
// DKIM key under the relay's selector and the DMARC policy.
//
// WHY ONE ACT AND NOT THREE REMOVALS. A domain stops sending as a whole. Between three separate
// removals the domain would stand half-announced — an SPF naming an address that no longer signs,
// or a DMARC policy over a domain with no key — and receivers judge exactly those combinations.
//
// WHAT STAYS. The domain's own address record is the installer's: it answers for the machine, not
// for the mail, and deleting it would take the installation off the air. The reverse DNS of the
// egress address is not in this zone at all — it is set where the address is rented. Both are why
// the inventory lists them read-only, and this run kind removes only what it lists as removable.
//
// WHAT IT DELETES IS THE INVENTORY'S OWN LIST. The three record names are composed in exactly one
// place (shared/mail.ts mailRecordNames, which the rows the Mail page measures are named by), so
// this run kind reads them off the inventory rather than composing a second spelling of
// `<stage>._domainkey.<domain>` that could drift from the one the publish writes. Each goes BY
// CONTENT — the content the book of DNS writes holds, or for a record published before the book
// the one its tag picks at the provider — so another service's TXT beside the SPF at the apex
// stays (plugins/unit/server/dns/dns-record.kit.ts states the rule).

export const MailDnsUnpublishParams = z.object({
  /** One of the two domains this installation sends as, as the Mail page names it. */
  domain: z.string().min(1),
});
export type MailDnsUnpublishParams = z.infer<typeof MailDnsUnpublishParams>;

/** The removable mail records of one sender domain, REFUSED for a domain this installation does not
 *  send as: mail leaves an installation as its platform domain (customer mail) and its unit apex
 *  (alert mail) and as nothing else, and a name outside those two is a domain whose records belong
 *  to somebody else entirely. */
function publishedRecordsOf(rows: DnsRecordRow[], domain: string): RemovableRecordRow[] {
  const mine = rows.filter((r): r is RemovableRecordRow => r.owner.kind === "mail" && r.owner.name === domain && r.removable && r.type === "TXT");
  if (mine.length === 0) {
    const senders = [...new Set(rows.filter((r) => r.owner.kind === "mail").map((r) => r.owner.name))];
    throw errValidation(
      `this installation publishes no mail records for ${domain} — it sends as ${senders.length > 0 ? senders.join(" and ") : "no domain the DNS inventory could read"}, ` +
        "and the mail records of any other domain are not this platform's to remove",
    );
  }
  return mine;
}

function mailDnsUnpublishSteps(params: MailDnsUnpublishParams, ports: DnsRecordPorts): Step[] {
  return [
    {
      name: ATTEST_TARGET_STEP,
      title: "Attest the domain is one this installation sends as",
      run: async (ctx) => {
        const records = publishedRecordsOf(await ownedRecords(ports), params.domain);
        ctx.checkpoint({ domain: params.domain, records: records.map((r) => ({ name: r.name, found: r.found, verdict: r.verdict })) });
        for (const record of records) {
          ctx.log("meta", `${record.name} (TXT) stands at ${record.found ?? "nothing — it is already absent"}`);
        }
      },
    },
    {
      name: "remove-records",
      title: "Remove the SPF, DKIM and DMARC records at the DNS provider",
      run: async (ctx) => {
        const dns = requireDnsProvider(ports);
        // Read again rather than carrying the attest step's list: a step is idempotent by contract
        // and may be re-run after a crash, and the names it deletes must be the ones that stand now.
        for (const record of publishedRecordsOf(await ownedRecords(ports), params.domain)) {
          await deleteRecord(ctx, dns, record);
        }
        ctx.log("meta", `${params.domain} announces no SPF, no DKIM key and no DMARC policy any more — its address record and the reverse DNS of the egress are untouched`);
      },
    },
  ];
}

export function makeMailDnsUnpublishDef(ports: DnsRecordPorts): RunDefinition<MailDnsUnpublishParams> {
  return {
    kind: "mail-dns-unpublish",
    paramsSchema: MailDnsUnpublishParams,
    mutating: true,
    plan: async (params) => {
      const records = publishedRecordsOf(await ownedRecords(ports), params.domain);
      requireDnsProvider(ports);
      return {
        kind: "mail-dns-unpublish",
        targetKind: "self",
        targetId: "manager",
        summary:
          `Unpublish the mail DNS of ${params.domain}: delete ${records.map((r) => r.name).join(", ")} at the DNS provider, ` +
          "which takes the domain's SPF, its DKIM key and its DMARC policy out of the zone in one act. The domain's own address record " +
          "stays (it is the installer's) and the reverse DNS of the egress address is not in this zone at all. What each record stood at " +
          "is written into this run's log before it goes.",
        steps: mailDnsUnpublishSteps(params, ports).map((s) => ({ name: s.name, title: s.title })),
        warnings: [
          `Mail sent as ${params.domain} fails the checks receivers make the moment these records are gone — unpublish a domain this installation still sends as only when it is being taken down.`,
        ],
        requiredSecrets: [],
      };
    },
    steps: (params) => mailDnsUnpublishSteps(params, ports),
  };
}
