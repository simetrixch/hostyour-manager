// The VaultSeeder port — the write-only Vault seed for a consumer's ceremony
// secrets. Lives in adapters/ (not the domain) so the concrete impl can implement it without an
// adapter->domain dependency; the onboarding domain re-exports it from vault-seeder.ts.
//
// ONE Vault and ONE identity, so no input here names either. The platform runs a single Vault, on
// the master: a slave's secrets live on it too, under the master's per-slave KV mount. Every write
// below therefore goes to the address the Controller itself authenticates against
// (adapters/vault/vault-self-seeder.ts VaultSelfAuth, from config.vault) over the Controller's own
// kubernetes-auth login — the same surface its credential store uses. An input carrying a Vault
// address or a login credential id would read as a routing choice, and there is none to make;
// worse, an address nothing dials is a fact an operator approving a run would read as the place the
// secrets land.
//
// WRITE-ONLY by policy: login -> PUT the single "app" KV entry -> revoke the token. Never READS and never LISTS, so a generated secret is irrecoverable by design
// — the honest residual the UI states.
// The three offboard deletes (deleteBuildRepoPat, deleteApp, deletePostgres) are the sanctioned
// exceptions and do NOT weaken that property: a KV-v2 metadata DELETE carries no response value, so
// the seeder learns a status code and never a secret. The grant they need is `delete` on the METADATA
// path only — the power to DESTROY an entry, never to read one. Read-before-write remains forbidden
// everywhere.
//
// CREATE-ONLY by policy (seed only): the app entry is written with KV-v2 check-and-set `cas: 0`,
// i.e. "write only if this entry does not exist yet". This is what makes seed-secrets genuinely
// idempotent — the property the 9-step onboard claims but did NOT have: every `generate:` key is
// re-minted on each run (secret-mint.ts mints unconditionally), so a blind overwrite meant a
// RE-RUN silently rotated a LIVE consumer's JWT signing keys + bootstrap token underneath its
// running pods, which read their env once at container start and never see the new values. That
// is not hypothetical: it is exactly how example-auth's pods ended up holding a bootstrap token
// that no longer matched Vault (2026-07-17).
// cas=0 is deliberately a WRITE, not a read-then-write: read-before-write would need `read` on the
// consumer tier and would forfeit the write-only property above. Vault decides existence
// server-side; the seeder still never learns the stored value.
import type { Stage } from "../../../shared/enums.ts";

export interface VaultSeedInput {
  stage: Stage;
  consumerName: string;
  /** KEY -> value; written under <stage>/consumer/<name>/app (contract v1.3, single entry). */
  data: Record<string, string>;
}

/** The BUILD-tier repo-PAT write (one PAT per unit): property `pat` at
 *  secret/build/<consumerName>/repo-pat — the entry the unit's consumer-build ExternalSecrets
 *  (build-git-https, build-npmrc, the bump credential) read. Stage-free by construction: a build is
 *  one image per release, never one per stage. */
export interface BuildRepoPatSeedInput {
  consumerName: string;
  /** The raw PAT value (opened from the sealed store by the caller; never logged). */
  pat: string;
}

/** The offboard/purge inverse: metadata-delete of secret/build/<consumerName>/repo-pat (all
 *  versions). */
export interface BuildRepoPatDeleteInput {
  consumerName: string;
}

/** The offboard inverse of `seed`: metadata-delete of the consumer's ceremony-secret entry at
 *  secret/<stage>/consumer/<consumerName>/app (ALL versions).
 *
 *  WHY this exists — it is the precondition that makes the cas=0 create-only seed above CORRECT
 *  rather than a trap. Offboard used to delete only the app-tier repo-pat and left this entry in
 *  Vault forever, which was merely untidy while the seed still overwrote. Under cas=0 it is a
 *  correctness bug: an offboard -> re-onboard finds the SURVIVING entry, Vault refuses the write,
 *  seed reports `created: false` ("left untouched"), and the supposedly fresh consumer silently
 *  INHERITS the offboarded one's JWT signing keys, bootstrap token and TOTP key — no error is
 *  raised anywhere. Deleting on offboard is what lets a re-onboard legitimately reach
 *  `created: true`; it is the missing half of create-only, not a tidy-up.
 *
 *  It MUST address the METADATA path, never the data path: a KV-v2 data DELETE is a SOFT,
 *  undelete-able delete that PRESERVES version information, and Vault allows cas=0 only where there
 *  is NO version information. A soft delete would therefore leave the re-onboard still refused AND
 *  the values hidden from ESO's read — a consumer that can neither be re-seeded nor read its own
 *  secrets, reported as a benign no-op. Only the metadata delete ("all version history will be
 *  removed") returns the path to genuinely non-existent. */
export interface AppSecretsDeleteInput {
  stage: Stage;
  consumerName: string;
}

/** The per-consumer PostgreSQL instance-superuser seed. Written to a
 *  SEPARATE leaf from the ceremony `app` entry — secret/<stage>/consumer/<name>/postgres, property
 *  `postgres-password` — and NOT into `app`, deliberately: `app` is cas=0 create-only, so a
 *  consumer that adds `services:[postgresql]` on a LATER re-pin would never get the property added. A
 *  separate leaf can be created independently, at the moment the service is first claimed.
 *
 *  Same two rules the `app` leaf proved, for the same reasons:
 *   - CREATE-ONLY (cas=0): a re-onboard must never rotate the password out from under a PGDATA that
 *     was initialised with it (the PVC survives offboard-abort with Prune=false), so a retry re-uses
 *     the same password. An existing entry is `created: false`, never an error — exactly like `seed`.
 *   - removed only at offboard/purge (deletePostgres), never by an abort cleanup: the PVC outlives
 *     the abort, so dropping the password would orphan a database nothing can open again. */
export interface PostgresSeedInput {
  stage: Stage;
  consumerName: string;
  /** The minted 32-byte-hex superuser password (mintPostgresSuperuserPassword). Write-only: the
   *  seeder puts it and never reads it back — the postgres image at initdb + ESO are its only readers. */
  password: string;
}

/** The offboard inverse of `seedPostgres`: metadata-delete of the instance-superuser entry at
 *  secret/<stage>/consumer/<consumerName>/postgres (ALL versions). METADATA path, never data —
 *  the same argument as AppSecretsDeleteInput: only removing every version returns the leaf to the
 *  "no version information" state a future create-only re-seed (cas=0) needs, so a re-onboarded name
 *  never silently inherits the offboarded instance's password.
 *
 *  Called UNCONDITIONALLY at offboard/purge and 404-TOLERANT: those runs are keyed on the consumer
 *  name (appId / name+cluster), not on a `services` claim, so they cannot know whether postgresql was
 *  ever claimed — a consumer that never claimed it simply 404s (the idempotent no-op), exactly as
 *  deleteApp does for a secret-less consumer. Every other non-2xx (a 403 policy gap) fails the run. */
export interface PostgresSecretDeleteInput {
  stage: Stage;
  consumerName: string;
}

/** The per-consumer MongoDB INSTANCE credential: `<stage>/consumer/<consumerName>/mongodb`, written
 *  iff the consumer's manifest asks for an instance of its own (`mongodb: standalone` or
 *  `replicaset`) rather than the cluster's shared replica set.
 *
 *  TWO properties, one entry. `root-password` is what the mongo image creates the SCRAM root user
 *  from on FIRST init and what the service-provisioner authenticates as to mint the consumer's own
 *  users. `keyfile` authenticates traffic BETWEEN replica-set members; a standalone never mounts it,
 *  and it is written anyway so a unit re-onboarded as a replica set finds it already there — the
 *  entry is create-only, so a second write to add it would be refused.
 *
 *  Same two rules as the postgres leaf, for the same reasons:
 *   - CREATE-ONLY (cas=0): the root user is created once, at initdb time, and never again. Rotating
 *     the password would lock the platform out of a live database whose volume survived.
 *   - removed only at offboard/purge (deleteMongodb), never by an abort cleanup: the volume outlives
 *     the abort, so dropping the password would orphan a database nothing can open again. */
export interface MongodbSeedInput {
  stage: Stage;
  consumerName: string;
  /** The minted 32-byte-hex root password (mintMongodbRootPassword). Write-only: the seeder puts it
   *  and never reads it back — the mongo image at first init, ESO and the service-provisioner are
   *  its only readers. */
  rootPassword: string;
  /** The minted replica-set keyfile (mintMongodbKeyfile) — base64 text, which is the only form
   *  mongod accepts for --keyFile. */
  keyfile: string;
}

/** The offboard inverse of `seedMongodb`: metadata-delete of `<stage>/consumer/<consumerName>/mongodb`
 *  (ALL versions), for the reason PostgresSecretDeleteInput states — only removing every version
 *  returns the leaf to the state a future create-only re-seed needs, so a re-onboarded name never
 *  inherits the offboarded instance's root password.
 *
 *  Called UNCONDITIONALLY and 404-TOLERANT: offboard and purge are keyed on the consumer, not on what
 *  its manifest asked for, so a consumer that ran on the shared replica set simply 404s. */
export interface MongodbSecretDeleteInput {
  stage: Stage;
  consumerName: string;
}

/** What the create-only seed actually did. Value-FREE: the seeder never learns, and never reports,
 *  a stored secret — only whether this run was the one that created the entry. */
export interface VaultSeedOutcome {
  /** true  ⇒ this run created the entry; the minted values are now the consumer's secrets.
   *  false ⇒ the entry already existed and was left UNTOUCHED (cas=0 refused). The values minted
   *          for this run are discarded, never written. The step is a no-op, not a failure. */
  created: boolean;
}

/** The TENANT's crypto entry: `<stage>/tenants/<guid>`, the ONE Vault leaf every member namespace of
 *  one tenant reads. Its five properties are the tenant's identity — the JWT keypair its IdP signs with
 *  and every member verifies against, the TOTP encryption key, the invite-gated bootstrap token, and
 *  the engine key its jobs presents and its engine checks.
 *
 *  WHY THE CONTROLLER AND NOT A ServiceClaim. Every other backing resource a tenant needs is claimed by
 *  the member chart that needs it and provisioned per NAMESPACE — which is exactly what makes a claim
 *  safe (the provisioner names its resources `<namespace>_<claim>`, so no claim can reach another
 *  unit's). These five are per-TENANT and shared: example-auth signs, and the engine and report of every
 *  app verify, out of the SAME entry, reached from four different namespaces through an ACL templated
 *  on the tenant annotation. A per-namespace claim would mint a different keypair per member and the
 *  IdP would sign with a key its own engine cannot verify. A per-tenant value needs a per-tenant
 *  writer, and the Controller already mints these exact kinds for a consumer (secret-mint.ts). */
export interface TenantCryptoSeedInput {
  stage: Stage;
  /** The bare guid — the leaf name, and the value the members' ACL template resolves to. */
  guid: string;
  /** property -> value, written under <stage>/tenants/<guid> as ONE entry. */
  data: Record<string, string>;
}

/** The purge inverse of `seedTenantCrypto`: metadata-delete of `<stage>/tenants/<guid>` (ALL versions).
 *  It has to be the METADATA delete for the same reason the consumer leaves do: a data delete is soft
 *  and keeps version information, and cas=0 is allowed only where none remains — so a soft delete would
 *  leave the next tenant minted with this guid silently INHERITING the purged tenant's signing key. */
export interface TenantCryptoDeleteInput {
  stage: Stage;
  guid: string;
}

export interface VaultSeeder {
  /** Create the consumer's app entry — ONCE. An existing entry is never overwritten (`created:
   *  false`); rotating or extending it is a separate, explicit action, never a side effect of
   *  re-running an onboard. */
  seed(input: VaultSeedInput): Promise<VaultSeedOutcome>;
  /** Create the per-consumer PostgreSQL instance-superuser entry — ONCE (cas=0). Written iff the
   *  consumer claims `postgresql`; an existing entry is never overwritten (`created: false`), so a
   *  re-onboard onto a surviving PGDATA re-uses the same password. */
  seedPostgres(input: PostgresSeedInput): Promise<VaultSeedOutcome>;
  /** Create the per-consumer MongoDB instance credential — ONCE (cas=0). Written iff the manifest
   *  asks for an instance of the consumer's own; an existing entry is never overwritten
   *  (`created: false`), so a re-onboard onto a surviving data volume re-uses the same root
   *  password instead of locking the platform out of it. */
  seedMongodb(input: MongodbSeedInput): Promise<VaultSeedOutcome>;
  /** Write the unit's build repo PAT to secret/build/<name>/repo-pat — ONCE (cas=0). An existing
   *  entry is ATTESTED, never overwritten (`created: false`): the seven hand-seeded platform units
   *  re-run the onboard run kind over a path that already stands, and the cas conflict is exactly the
   *  existence proof that keeps the write-only rule intact (no read, not even of metadata).
   *  Fail-closed on every other error. */
  seedBuildRepoPat(input: BuildRepoPatSeedInput): Promise<VaultSeedOutcome>;
  /** Remove the unit's build repo PAT (offboard/purge). Idempotent — an absent entry (404) is ok. */
  deleteBuildRepoPat(input: BuildRepoPatDeleteInput): Promise<void>;
  /** Remove the consumer's ceremony secrets (offboard) — see AppSecretsDeleteInput for why a
   *  surviving entry silently corrupts the NEXT onboard. Idempotent: an absent entry (404) is ok,
   *  and that is a NORMAL case, not just a crash-retry — `seed` returns early without writing when
   *  the manifest declares no secrets (or all are optional and none supplied), so a large class of
   *  consumers legitimately has no entry to delete. Every other non-2xx fails the run: a 403 is a
   *  missing policy grant, never "already gone". */
  deleteApp(input: AppSecretsDeleteInput): Promise<void>;
  /** Remove the consumer's PostgreSQL instance-superuser entry (offboard/purge) — metadata-delete of
   *  secret/<stage>/consumer/<name>/postgres. Called UNCONDITIONALLY + 404-tolerant (offboard/purge
   *  carry no `services`, so a consumer that never claimed postgresql simply 404s); every other non-2xx
   *  fails the run — see PostgresSecretDeleteInput. */
  deletePostgres(input: PostgresSecretDeleteInput): Promise<void>;
  /** Remove the consumer's MongoDB instance credential (offboard/purge) — metadata-delete of
   *  secret/<stage>/consumer/<name>/mongodb. Called UNCONDITIONALLY + 404-tolerant for the same
   *  reason deletePostgres is: those runs cannot know what the manifest asked for, so a consumer
   *  that ran on the shared replica set simply 404s. */
  deleteMongodb(input: MongodbSecretDeleteInput): Promise<void>;
  /** Create the tenant's crypto entry — ONCE (cas=0). An existing entry is never overwritten
   *  (`created: false`), which is what makes a re-run of create-tenant safe: the values are re-minted
   *  on every run (the mint is unconditional), so a blind overwrite would rotate a LIVE tenant's
   *  signing keys and bootstrap token out from under pods that read their env once, at container
   *  start — the failure that already happened to example-auth on the consumer side. */
  seedTenantCrypto(input: TenantCryptoSeedInput): Promise<VaultSeedOutcome>;
  /** Remove the tenant's crypto entry (purge). Idempotent — an absent entry (404) is ok, which is a
   *  NORMAL case and not only a crash-retry: a tenant whose create-tenant died before the seed step
   *  has none. Every other non-2xx fails the run; a 403 is a missing grant, never "already gone". */
  deleteTenantCrypto(input: TenantCryptoDeleteInput): Promise<void>;
}
