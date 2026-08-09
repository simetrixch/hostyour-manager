// The unit DNS port (the public address belongs to the unit, not to the server). A unit gets
// EXACTLY ONE record — a consumer the A record `<name>.<unitApex>`, a tenant the wildcard A
// `*.<subdomain>.<unitApex>` that covers every member one level below — created at onboarding,
// updated on a move, removed at offboard and purge. Kept a PORT so the run steps depend on the
// abstraction; the Cloudflare impl is cloudflare-dns.ts, the fake is testing/fake.ts.
//
// Only A records: the record points at the target cluster's IP, and that IP is READ off the
// cluster's own A record (readRecordContent) rather than computed — the cluster's address record is
// the one authority for where the cluster is reachable.

/** The record types this port manages. The unit record and the cluster address it copies are both
 *  A records; nothing else is ever written through here. */
export type DnsRecordType = "A";

export interface DnsProvider {
  /** Idempotent upsert-by-(name, type): create the record, or overwrite the existing one's content
   *  in place — a move is exactly this call with a new content. Never proxied: the platform
   *  terminates TLS itself, and a proxy in front would break cert issuance and SSH. */
  upsertRecord(input: { name: string; type: DnsRecordType; content: string; signal?: AbortSignal }): Promise<{ created: boolean }>;
  /** Idempotent delete-by-(name, type): remove every record of that name and type. An absent record
   *  resolves { deleted: 0 } — offboard and purge re-run safely, and a unit whose record was never
   *  created (a run that died before provision-dns) is a no-op, not an error. */
  deleteRecord(input: { name: string; type: DnsRecordType; signal?: AbortSignal }): Promise<{ deleted: number }>;
  /** Read one record's content, or null when no such record exists. provision-dns reads the target
   *  cluster's own A record with this — the unit record's content IS that address. */
  readRecordContent(input: { name: string; type: DnsRecordType; signal?: AbortSignal }): Promise<string | null>;
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
