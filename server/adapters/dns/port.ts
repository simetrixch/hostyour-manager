// The unit DNS port (the public address belongs to the unit, not to the server). A unit gets
// EXACTLY ONE record — a consumer the CNAME `<label>.<stage apex>`, a tenant the wildcard CNAME
// `*.<subdomain>.<unitApex>` that covers every member one level below — created at onboarding,
// updated on a move, removed at offboard and purge. Kept a PORT so the run steps depend on the
// abstraction; the Cloudflare impl is cloudflare-dns.ts, the fake is testing/fake.ts.
//
// A unit record is only ever a CNAME onto the target cluster's FQDN, never an address: the cluster's
// name is the one authority for where it is reachable, and DNS resolves it — through a master
// identity that is itself a CNAME onto one of two machines as well (plugins/unit/server/unit-dns.ts).
//
// TXT rides the same three calls because the mail records of a sender domain (SPF, DKIM, DMARC) are
// records of this installation too: the DNS inventory reads them and `dns-remove` and
// `mail-dns-unpublish` take them back (plugins/unit/server/dns/dns-inventory.ts). Publishing them stays
// the programs checkout's publish-mail-dns program — one writer, as mail-dns-publish's header states — so
// what enters through here for a TXT name is the READING and the REMOVAL, never a second writer of
// the published content.

/** The record types this port manages, declared in shared/dns.ts because the inventory view the
 *  browser renders is typed on the same set, and re-exported here for this port's own callers. */
import type { DnsRecordType } from "../../../shared/dns.ts";
export type { DnsRecordType };

/** A record as it stands at the provider: its content, whether the provider's proxy answers for its name,
 *  and its TTL in seconds, 1 being the provider's automatic one. */
export interface StandingDnsRecord {
  content: string;
  proxied: boolean;
  ttl: number;
}

export interface DnsProvider {
  /** Idempotent upsert-by-(name, type): create the record, or overwrite the existing one's content
   *  in place — a move is exactly this call with a new content. Never proxied: the platform
   *  terminates TLS itself, and a proxy in front would break cert issuance and SSH. */
  upsertRecord(input: { name: string; type: DnsRecordType; content: string; signal?: AbortSignal }): Promise<{ created: boolean }>;
  /** Idempotent delete-by-(name, type): remove every record of that name and type, or, with
   *  `content`, only the records whose content equals it. An absent record resolves { deleted: 0 } —
   *  offboard and purge re-run safely, and a unit whose record was never created (a run that died
   *  before provision-dns) is a no-op, not an error. A TXT is always deleted BY CONTENT: a sender
   *  domain's apex carries other services' TXT beside the SPF, and a deletion by name alone would
   *  take a record this platform never wrote (plugins/unit/server/dns/dns-record.kit.ts holds that rule). */
  deleteRecord(input: { name: string; type: DnsRecordType; content?: string; signal?: AbortSignal }): Promise<{ deleted: number }>;
  /** Read one record's content, or null when no such record exists. provision-dns reads the target
   *  cluster's own A record with this — the unit record's content IS that address. */
  readRecordContent(input: { name: string; type: DnsRecordType; signal?: AbortSignal }): Promise<string | null>;
  /** EVERY record of that name and type, in the provider's order; empty when none stands. The
   *  reading for a TXT name, because a sender domain's apex carries other services' TXT beside the
   *  SPF and the first record answers about the wrong one — the book of DNS writes picks the record
   *  by its version tag (shared/mail.ts MAIL_RECORD_TAG) and judges its rows against the whole list.
   *  A TXT content is answered as the ONE text the record is, however the provider stores it, and
   *  `deleteRecord` compares a content against the same text. An MX is read only, never written: a run
   *  that writes beside a mail domain proves its MX untouched (own-domain-records.ts mailRecordHashes),
   *  answered as `<priority> <host>`. */
  listRecordContents(input: { name: string; type: DnsRecordType | "MX"; signal?: AbortSignal }): Promise<string[]>;
  /** Every record of that name and type as it stands, its proxy flag and TTL with it: what a run reads
   *  of a customer's record it replaces, so that an abort can write it back as it stood. */
  listStandingRecords(input: { name: string; type: DnsRecordType; signal?: AbortSignal }): Promise<StandingDnsRecord[]>;
  /** Create ONE record beside any others of that name and type — what an abort writes back where a
   *  run deleted several address records of a customer's host. DNS-only with the automatic TTL unless
   *  `proxied` and `ttl` say otherwise: only a customer's record written back as it stood carries its
   *  own, every record the platform writes for itself must resolve to the cluster. */
  createRecord(input: { name: string; type: DnsRecordType; content: string; proxied?: boolean; ttl?: number; signal?: AbortSignal }): Promise<void>;
  /** The name of the zone that holds `name` (`example.org` for `cycleshop.show.example.org`): "our
   *  domain" of a host, before which a dev or test stage stands (unit-host.ts stageHost). THROWS
   *  DnsZoneUnknownError where no zone of this provider holds it. */
  zoneName(input: { name: string; signal?: AbortSignal }): Promise<string>;
}

/** A name no zone of this provider's token covers: the token is scoped elsewhere, or the domain is
 *  not on the provider. Its own type because a caller may be asked to act only where this
 *  installation manages the zone — a record in a zone nobody here manages is nobody's here to
 *  write or remove — and that caller tells this apart from a failure by type, never by text. */
export class DnsZoneUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsZoneUnknownError";
  }
}

/** Any DNS API failure — a transport error, a non-2xx, or a body whose `success` flag is false.
 *  Carries the provider's own error text verbatim (never a generic mask): the run step surfaces it,
 *  and an API failure breaks the run: a record that may or may not exist is exactly the leftover
 *  this port exists to rule out, so a swallowed error would leave the address in an unknown state. */
export class DnsError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "DnsError";
    this.status = status;
  }
}
