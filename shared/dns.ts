// The DNS vocabulary both ends share, in two lists that answer two different questions.
//
// THE INVENTORY answers "which records is this installation responsible for": it is DERIVED from
// the state that does exist (the registrations, the cluster rows, the sender domains) and every row
// is then READ at the provider — a consumer's host, a tenant's wildcard, the mail records of a
// sender domain, standing or absent. A stored list could not answer this, because it would go on
// naming records a hand at the provider has long since changed.
//
// THE BOOK answers "which records did this Manager actually write": one row per record a run of
// this Manager inserted or updated, kept in the `dns_writes` table until the run kind that takes the
// record back deletes it. The inventory lists everything the installation could own; the book lists
// only what a run here changed, which is what an operator tearing an installation down or checking
// a day's work wants to see first (hostyour-manager#171).
import type { DnsWriteAct, DnsWriteOwnerKind, Stage } from "./enums.ts";
import type { MailDnsRecord } from "./mail.ts";

/** The record types the DnsProvider port writes and reads: CNAME for the unit records the
 *  onboarding run kinds provision, onto their cluster's FQDN; TXT for the mail records of a sender
 *  domain (SPF, DKIM, DMARC); A only read and removed — the master's egress address, and an address
 *  record standing where a unit's CNAME belongs. Nothing else is ever written through this platform. */
export const DNS_RECORD_TYPE = ["A", "CNAME", "TXT"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPE)[number];

/** What a row of the inventory may carry — the types above plus the PTR, which lives at the
 *  hosting provider rather than in the zone and is therefore listed and never removed here. */
export type DnsRowType = DnsRecordType | "PTR";

/** WHOSE record a row is, which is also what decides whether this Manager may take it back:
 *   - consumer / tenant — the unit's ONE record per stage, written by provision-dns and removed by
 *                         offboard and purge (server/domains/units/unit-dns.ts).
 *   - mail             — a sender domain's SPF, DKIM or DMARC, published by mail-dns-publish.
 *   - installer        — a record of the installation that no run of this Manager wrote: the sender
 *                        domain's own address record, and the reverse DNS of the egress address,
 *                        which is set where the address is rented. Listed read-only. */
export type DnsOwnerKind = DnsWriteOwnerKind | "installer";

/** Who a record belongs to, in the words the operator knows the thing by: a consumer's unit name, a
 *  tenant's subdomain, a sender domain. `stage` is carried where the owner HAS one — a unit stands
 *  at one stage and its record is that stage's zone; a sender domain is the installation's and
 *  stands at no stage. */
export interface DnsOwner {
  kind: DnsOwnerKind;
  name: string;
  stage?: Stage;
}

/** What the reading found, against what the owner's state says must stand there. `other` is the
 *  interesting one: a record under this installation's own name carrying content nobody here would
 *  write is what an installation that is gone leaves behind (unit-dns.ts readStandingHost). */
export type DnsVerdict = "standing" | "absent" | "other";

/** ONE record: who owns it, the name asked at the provider, what the owner's state says it must
 *  carry, what was found (null for no record at all), and whether a `dns-remove` run may take it
 *  back — false for every row the installer or the hosting provider owns. A mail row also says
 *  WHICH of the five mail records it is: a TXT name carries other services' records beside ours,
 *  and the record's tag (shared/mail.ts MAIL_RECORD_TAG) is what picks ours among them. */
export interface DnsRecordRow {
  owner: DnsOwner;
  name: string;
  type: DnsRowType;
  record?: MailDnsRecord;
  expected: string;
  found: string | null;
  verdict: DnsVerdict;
  removable: boolean;
}

/** GET /api/dns — every record the Manager is responsible for, read at the provider at `readAt`.
 *  `skipped` carries ONE sentence per source the walk could not read: a registration scan that
 *  failed or a mail measurement without a master is not an installation with fewer records, and an
 *  inventory that silently shrank would tell the operator the zone is clean. */
export interface DnsInventoryView {
  rows: DnsRecordRow[];
  skipped: string[];
  readAt: string;
}

/** POST /api/runs {kind: "dns-remove"} — take back the listed records, every one a row the
 *  inventory names as removable, in ONE run with one step per record. At least one; a record
 *  listed twice is refused. */
export interface DnsRemoveInput {
  records: { name: string; type: DnsRecordType }[];
}

/** ONE row of the book: the record a run of this Manager wrote, what the write did, whose record it
 *  is, which run wrote it and when, and what stands under the name at the provider NOW — `found`
 *  is every record of that name and type, `verdict` judges it against the content the book holds.
 *  Both are null where the reading could not be taken (no DNS provider wired), and the view's
 *  `skipped` says so; a row is never dropped for it, because the book is the Manager's own record
 *  and stands whether or not the zone can be asked. */
export interface DnsWriteRow {
  name: string;
  type: DnsRecordType;
  content: string;
  act: DnsWriteAct;
  owner: { kind: string; name: string; stage?: Stage };
  runId: string;
  writtenAt: string;
  found: string | null;
  verdict: DnsVerdict | null;
}

/** GET /api/dns/writes — the book, read against the provider at `readAt`. Only removable records
 *  ever enter it, so every row may be taken back with `dns-remove`; the run still resolves the name
 *  in the inventory first, which is the permission. */
export interface DnsWritesView {
  rows: DnsWriteRow[];
  skipped: string[];
  readAt: string;
}
