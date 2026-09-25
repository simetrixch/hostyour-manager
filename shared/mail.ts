// The mail vocabulary both ends share: what the Manager publishes and measures for the installation's
// mail DNS. An installation sends as exactly two domains — customer mail as its platform domain, alert
// mail as its unit apex (the two names the relay's ALLOWED_SENDER_DOMAINS carries) — and receiving is
// never the platform's; everything here is about what receivers of OUR mail look up.
import type { DmarcPolicy, Stage } from "./enums.ts";

/** POST /api/runs {kind: "mail-dns-publish"} — the mail DNS of ONE of the two sender domains (the
 *  master's map names both), published from the master by the catalogue's publish-mail-dns program.
 *  The two DMARC values are the operator's; the egress address is read off the master's own A record. */
export interface MailDnsPublishInput {
  serverId: string;
  senderDomain: string;
  dmarcPolicy: DmarcPolicy;
  dmarcMailbox: string;
}

/** Which of the two roles a sender domain plays: the platform domain carries customer mail, the
 *  unit apex the alerts. */
export type SenderRole = "customer mail" | "alert mail";

/** The five records a receiver judges the installation's mail by. */
export type MailDnsRecord = "spf" | "a" | "dkim" | "dmarc" | "ptr";

/** One record as measured against what the installation needs: the NAME asked, what the master's
 *  map and address say it must carry (`expected`), what public DNS answers (`found`, null for no
 *  record), and the verdict. `note` says why a red row is red in a sentence the operator acts on. */
export interface MailDnsRow {
  record: MailDnsRecord;
  name: string;
  expected: string;
  found: string | null;
  ok: boolean;
  note?: string;
}

export interface MailDnsDomainView {
  domain: string;
  role: SenderRole;
  rows: MailDnsRow[];
}

/** GET /api/mail/dns — the mail DNS of the installation as receivers see it: the master whose map
 *  names the sender domains, the stage's mail SENDER where a unit declares one (its SMTP entry, on the
 *  cluster it stands on), the name mail leaves by and the address that name resolves to, and one block
 *  per sender domain. Measured against PUBLIC resolvers at `measuredAt`, never against the machine's. */
export interface MailDnsView {
  master: { serverId: string; name: string; fqdn: string; stage: Stage };
  /** The unit whose registration at the master's stage carries the SMTP entry, and the FQDN of the
   *  cluster it stands on — or null, where the master's relay delivers directly. */
  sender: { unit: string; cluster: string } | null;
  /** The name mail leaves by — the sender's cluster, or the master's identity where no unit sends — and
   *  the address it resolves to at public DNS, CNAMEs followed; null where it resolves to none. */
  egress: { name: string; address: string | null };
  domains: MailDnsDomainView[];
  measuredAt: string;
}

/** Where the mail of a stage leaves, read once for the Mail page and for mail-dns-publish alike, so
 *  the page measures exactly what a publish writes: the stage's SENDER where a unit declares one, the
 *  name mail leaves by, the address it resolves to at public DNS, and the key the sender signs the
 *  platform domain with as the base64 of `p=` — null where no unit sends or the Manager holds none. */
export interface MailEgress {
  sender: { unit: string; cluster: string } | null;
  name: string;
  address: string | null;
  dkimPublicKey: string | null;
}

/** The three records this platform PUBLISHES for a sender domain and can take back: the SPF at the
 *  apex, the DKIM key under the relay's selector (the stage), the DMARC policy. The address record
 *  and the reverse DNS are not here because no run of this Manager owns them. */
export const PUBLISHED_MAIL_RECORD = ["spf", "dkim", "dmarc"] as const satisfies readonly MailDnsRecord[];
export type PublishedMailRecord = (typeof PUBLISHED_MAIL_RECORD)[number];

/** The NAME each published record stands under — composed here and nowhere else, so the Mail page's
 *  measurement, the DNS inventory and the book of DNS writes ask about one spelling. */
export function mailRecordNames(domain: string, stage: Stage): Record<PublishedMailRecord, string> {
  return { spf: domain, dkim: `${stage}._domainkey.${domain}`, dmarc: `_dmarc.${domain}` };
}

/** Which TXT at a name IS the published record: the apex carries other services' TXT beside the
 *  SPF, and a receiver picks the record by its version tag, so every reader here does the same. */
export const MAIL_RECORD_TAG: Record<PublishedMailRecord, (txt: string) => boolean> = {
  spf: (txt) => txt.trim().toLowerCase().startsWith("v=spf1"),
  dkim: (txt) => txt.trim().toLowerCase().startsWith("v=dkim1"),
  dmarc: (txt) => txt.trim().toLowerCase().startsWith("v=dmarc1"),
};
