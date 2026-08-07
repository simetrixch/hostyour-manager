// Reading whether a tenant still has anybody who can administer it.
//
// A tenant whose first-admin invitation was never accepted, or whose only administrator was removed,
// is a tenant nobody can get into. Its pods run, its databases answer, its ingress serves — and no
// human can administer it. Nothing in the product noticed that state, which is what this port exists
// to end.
//
// Kept a PORT (types only) for the same reason every other one is: the domain step depends on the
// abstraction, `adapters-own-io-libs` keeps the fetch inside adapters/, and the fake ships beside it
// so a check is tested without a tenant.
//
// SECURITY: the bootstrap token is a credential. It is read per call out of the tenant's Vault entry,
// held in memory for the length of the call, sent as a header value, and never persisted, logged or
// returned. The redactor in server/security/ is what keeps it out of a run log if it ever reaches
// one.

/** What is asked of one tenant. */
export interface TenantHealthRequest {
  /** The full URL of the tenant's auth bootstrap status endpoint, on its own public ingress. */
  url: string;
  /** The header the token is sent under. */
  tokenHeader: string;
  /** The bootstrap token (in-call memory; sent as a header, never logged). */
  token: string;
  signal?: AbortSignal;
}

/** What one tenant answered, or why it could not.
 *
 * Three outcomes and not two, because the difference between them is the whole design. A tenant that
 * cannot be reached is NOT a tenant without administrators — it may be mid-restart, mid-deploy, or
 * behind a DNS change — and a check that reports those as findings is a check somebody mutes within
 * a week. */
export type TenantHealth =
  /** The endpoint answered. `admins` is what it reported. */
  | { readonly reached: true; readonly admins: number }
  /** The endpoint did not answer, or answered something this cannot read. `because` is written for
   *  the operator reading the run log, and carries no credential. */
  | { readonly reached: false; readonly because: string };

export interface TenantHealthReader {
  /** Asks one tenant. Never rejects: an unreachable endpoint is an ANSWER here — `reached: false` —
   *  because a transport error is a normal state of a cluster and not a failure of the check. What
   *  would make this reject is a defect in the caller, not in the tenant. */
  read(input: TenantHealthRequest): Promise<TenantHealth>;
}
