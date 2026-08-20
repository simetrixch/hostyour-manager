import { readFileSync } from "node:fs";
import type { VaultSeeder, VaultSeedInput, VaultSeedOutcome, PostgresSeedInput, PostgresSecretDeleteInput, MongodbSeedInput, MongodbSecretDeleteInput, BuildRepoPatSeedInput, BuildRepoPatDeleteInput, AppSecretsDeleteInput, TenantCryptoSeedInput, TenantCryptoDeleteInput } from "./seeder-port.ts";
import { KV_MOUNT, VaultError } from "./port.ts";

// The concrete VaultSeeder: write-only KV-v2 seed of a consumer's ceremony
// secrets. Flow: login -> PUT the single "app" entry -> revoke the token. Never reads/lists; the
// metadata deletes below (deleteBuildRepoPat, deleteApp, deletePostgres) are the sanctioned
// exceptions — they destroy an entry without ever learning its value, so the write-only property
// holds. The only place this Vault HTTP lives (dep-cruiser: adapters own IO); mirrors vault-kv.ts's
// fetch style.
//
// ONE identity for every call: the Controller's own kubernetes-auth login (login() below) against
// the one Vault on the master, which is where a slave's secrets live too — under the master's
// per-slave KV mount. No call takes an address from its input, and none could usefully: the pod's
// ServiceAccount JWT is only valid for the Vault the Controller is configured against.
//    NOTE: the `controller` Vault policy must be granted create/update on
//    secret/data/build/+/repo-pat (and delete on the matching metadata path) for the build
//    repo-pat write, create/update on secret/data/<stage>/consumer/+/app for the ceremony
//    seed, delete on secret/metadata/<stage>/consumer/+/app for the offboard delete, and the
//    same pair on secret/{data,metadata}/<stage>/tenants/+ for the tenant crypto entry,
//    — the calls here fail closed (403) until they are. That policy is IMPERATIVE (the
//    deploy-gitops program's vault seed, digita-deploy ansiwise/programs/), not ArgoCD-owned, so
//    merging hostyour-cloud does not ship it: re-run deploy-gitops on the master to widen it.

/** The Controller's own Vault login facts (kubernetes-auth) — config.vault, the same surface the
 *  credential store's VaultKvClient authenticates with. Optional rather than required because a
 *  Controller without Vault is a real state (a dev process, the checks); absent ⇒ every write fails
 *  closed with a clear error instead of inventing an identity. */
export interface VaultSelfAuth {
  addr: string;
  k8sAuthMount: string;
  k8sRole: string;
  saTokenPath: string;
}

export interface VaultSeederDeps {
  /** The Controller's own kubernetes-auth identity — the identity of every write in this adapter. */
  self?: VaultSelfAuth;
}

export class VaultSelfSeeder implements VaultSeeder {
  constructor(private readonly deps: VaultSeederDeps) {}

  async seed(input: VaultSeedInput): Promise<VaultSeedOutcome> {
    const { addr, token } = await this.login();
    try {
      return await this.putApp(addr, input, token);
    } finally {
      // Best-effort self-revoke: the seed already succeeded/failed on its own merits; a revoke
      // failure must not mask that, and the token is short-lived regardless.
      await this.revoke(addr, token).catch(() => undefined);
    }
  }

  async seedPostgres(input: PostgresSeedInput): Promise<VaultSeedOutcome> {
    // Same create-only (cas=0) shape as `seed`, but a SEPARATE leaf (<stage>/consumer/<name>/postgres,
    // property postgres-password) so a consumer that adds services:[postgresql] on a later re-pin
    // still gets it — the `app` leaf's cas=0 would refuse. cas=0 also
    // makes a retry onto a surviving PGDATA re-use the same password (created:false), never rotate
    // the superuser out from under a booted instance.
    const { addr, token } = await this.login();
    try {
      return await this.putConsumerLeaf(addr, `${input.stage}/consumer/${input.consumerName}/postgres`, { "postgres-password": input.password }, token, "postgres");
    } finally {
      await this.revoke(addr, token).catch(() => undefined);
    }
  }

  async seedMongodb(input: MongodbSeedInput): Promise<VaultSeedOutcome> {
    // Same create-only (cas=0) shape and the same SEPARATE-leaf reasoning as seedPostgres: a
    // consumer that asks for its own MongoDB on a later re-pin still gets the entry, which the
    // `app` leaf's cas=0 would refuse. Both properties go in ONE write — the entry is create-only,
    // so a second write to add the keyfile later would be refused and a unit re-onboarded from
    // standalone to replicaset would have no keyfile to mount.
    const { addr, token } = await this.login();
    try {
      return await this.putConsumerLeaf(addr, `${input.stage}/consumer/${input.consumerName}/mongodb`, {
        "root-password": input.rootPassword,
        keyfile: input.keyfile,
      }, token, "mongodb");
    } finally {
      await this.revoke(addr, token).catch(() => undefined);
    }
  }

  async deleteMongodb(input: MongodbSecretDeleteInput): Promise<void> {
    // The offboard/purge inverse of seedMongodb — METADATA delete, for the reason deleteConsumerLeaf
    // states.
    await this.deleteConsumerLeaf(`${input.stage}/consumer/${input.consumerName}/mongodb`, "mongodb-secret");
  }

  async seedBuildRepoPat(input: BuildRepoPatSeedInput): Promise<VaultSeedOutcome> {
    // cas=0 makes the write attest-or-create: the seven hand-seeded platform units re-run the onboard
    // run kind over a path that already stands, and the cas conflict is the existence proof
    // (`created: false`) without any read, not even of metadata.
    const { addr, token } = await this.login();
    try {
      const path = `build/${input.consumerName}/repo-pat`;
      const res = await fetch(`${addr}/v1/${KV_MOUNT}/data/${path}`, {
        method: "POST",
        headers: { "x-vault-token": token, "content-type": "application/json" },
        body: JSON.stringify({ data: { pat: input.pat }, options: { cas: 0 } }),
      });
      if (res.ok) return { created: true };
      const detail = await res.text().catch(() => "");
      if (res.status === 400 && detail.includes("check-and-set")) return { created: false };
      throw new VaultError(`vault build repo-pat put failed for ${KV_MOUNT}/${path} (${res.status})`, res.status);
    } finally {
      await this.revoke(addr, token).catch(() => undefined);
    }
  }

  async deleteBuildRepoPat(input: BuildRepoPatDeleteInput): Promise<void> {
    const { addr, token } = await this.login();
    try {
      const path = `build/${input.consumerName}/repo-pat`;
      // KV-v2 metadata delete removes every version (the slave.sh offboard precedent); an already-
      // absent entry (404) is the idempotent no-op offboard retries rely on.
      const res = await fetch(`${addr}/v1/${KV_MOUNT}/metadata/${path}`, {
        method: "DELETE",
        headers: { "x-vault-token": token },
      });
      if (!res.ok && res.status !== 404) throw new VaultError(`vault build repo-pat delete failed for ${KV_MOUNT}/${path} (${res.status})`, res.status);
    } finally {
      await this.revoke(addr, token).catch(() => undefined);
    }
  }

  async deleteApp(input: AppSecretsDeleteInput): Promise<void> {
    const { addr, token } = await this.login();
    try {
      const path = `${input.stage}/consumer/${input.consumerName}/app`;
      // METADATA delete (hard), never the data delete (soft): only removing every version returns
      // the path to the "no version information" state that the next onboard's cas=0 write requires
      // — a soft delete leaves the re-onboard refused AND hides the values from ESO. See
      // seeder-port.ts (AppSecretsDeleteInput) for the full argument.
      const res = await fetch(`${addr}/v1/${KV_MOUNT}/metadata/${path}`, {
        method: "DELETE",
        headers: { "x-vault-token": token },
      });
      // 404 is the idempotent no-op: an offboard retry, but also the consumer that never had an
      // entry (a manifest declaring no secrets makes seed return early). Everything else throws —
      // a 403 is a missing metadata-delete grant, and swallowing it would hand the next onboard the
      // stale keys this step exists to destroy.
      if (!res.ok && res.status !== 404) throw new VaultError(`vault app-secrets delete failed for ${KV_MOUNT}/${path} (${res.status})`, res.status);
    } finally {
      await this.revoke(addr, token).catch(() => undefined);
    }
  }

  async deletePostgres(input: PostgresSecretDeleteInput): Promise<void> {
    // The offboard/purge inverse of seedPostgres — METADATA delete, for the reason
    // deleteConsumerLeaf states.
    await this.deleteConsumerLeaf(`${input.stage}/consumer/${input.consumerName}/postgres`, "postgres-secret");
  }

  async seedTenantCrypto(input: TenantCryptoSeedInput): Promise<VaultSeedOutcome> {
    // Same create-only (cas=0) shape as the consumer leaves, on the ONE entry every member namespace
    // of this tenant reads. cas=0 is what makes a re-run of create-tenant safe rather than
    // destructive: the values are re-minted on every run, so an unconditional write would rotate a
    // live tenant's signing key and bootstrap token out from under pods that read their env once.
    const { addr, token } = await this.login();
    try {
      const path = `${input.stage}/tenants/${input.guid}`;
      const res = await fetch(`${addr}/v1/${KV_MOUNT}/data/${path}`, {
        method: "POST",
        headers: { "x-vault-token": token, "content-type": "application/json" },
        body: JSON.stringify({ data: input.data, options: { cas: 0 } }),
      });
      if (res.ok) return { created: true };
      const detail = await res.text().catch(() => "");
      if (res.status === 400 && detail.includes("check-and-set")) return { created: false };
      throw new VaultError(`vault tenant-crypto seed put failed for ${KV_MOUNT}/${path} (${res.status})`, res.status);
    } finally {
      await this.revoke(addr, token).catch(() => undefined);
    }
  }

  async deleteTenantCrypto(input: TenantCryptoDeleteInput): Promise<void> {
    // METADATA delete (hard, all versions), never the data delete (soft): only removing every version
    // returns the leaf to the "no version information" state a future create-only seed needs, so a
    // tenant minted later with the same guid can never inherit the purged tenant's signing key.
    const { addr, token } = await this.login();
    try {
      const path = `${input.stage}/tenants/${input.guid}`;
      const res = await fetch(`${addr}/v1/${KV_MOUNT}/metadata/${path}`, {
        method: "DELETE",
        headers: { "x-vault-token": token },
      });
      // 404 is the idempotent no-op: a retry, and also the normal case of a tenant whose create-tenant
      // died before the seed step. Everything else throws — a 403 is a missing metadata-delete grant.
      if (!res.ok && res.status !== 404) throw new VaultError(`vault tenant-crypto delete failed for ${KV_MOUNT}/${path} (${res.status})`, res.status);
    } finally {
      await this.revoke(addr, token).catch(() => undefined);
    }
  }

  /** The Controller's OWN kubernetes-auth login against ITS Vault — the identity of every write
   *  here. Fail-closed when the Controller carries no Vault login. */
  private async login(): Promise<{ addr: string; token: string }> {
    const self = this.deps.self;
    if (!self) {
      throw new VaultError(
        "no Vault identity for this write: the Controller has no own Vault login (VAULT_ADDR unset) — refusing to continue",
      );
    }
    let jwt: string;
    try {
      jwt = readFileSync(self.saTokenPath, "utf8").trim();
    } catch (err) {
      throw new VaultError(`controller ServiceAccount token not readable at ${self.saTokenPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const res = await fetch(`${self.addr}/v1/auth/${self.k8sAuthMount}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: self.k8sRole, jwt }),
    });
    if (!res.ok) throw new VaultError(`vault kubernetes login failed (${res.status})`, res.status);
    const body = (await res.json()) as { auth?: { client_token?: string } };
    const token = body.auth?.client_token;
    if (!token) throw new VaultError("vault kubernetes login returned no client_token");
    return { addr: self.addr, token };
  }

  /** CREATE-ONLY write of the consumer's app entry (see seeder-port.ts). `cas: 0` tells Vault to
   *  accept the write ONLY when the entry does not exist yet; an existing entry is refused with
   *  400 + "check-and-set parameter did not match the current version", which we translate into
   *  `created: false` rather than an error — a re-run legitimately finds the secrets already
   *  seeded and must leave them alone. Every OTHER 400 (and any other non-2xx) still fails the
   *  run: only the cas conflict is a known, benign outcome, and matching on the message keeps a
   *  malformed-payload 400 from being swallowed as "already seeded". */
  private async putApp(addr: string, input: VaultSeedInput, token: string): Promise<VaultSeedOutcome> {
    const path = `${input.stage}/consumer/${input.consumerName}/app`;
    const res = await fetch(`${addr}/v1/${KV_MOUNT}/data/${path}`, {
      method: "POST",
      headers: { "x-vault-token": token, "content-type": "application/json" },
      body: JSON.stringify({ data: input.data, options: { cas: 0 } }),
    });
    if (res.ok) return { created: true };
    const detail = await res.text().catch(() => "");
    if (res.status === 400 && detail.includes("check-and-set")) return { created: false };
    throw new VaultError(`vault seed put failed for ${KV_MOUNT}/${path} (${res.status})`, res.status);
  }

  /** CREATE-ONLY write of ONE per-consumer database-instance leaf — the PostgreSQL superuser, the
   *  MongoDB instance credential, and whatever a third backing service adds. Same cas=0 semantics as
   *  putApp: a pre-existing entry (cas conflict) is `created: false`, not an error — a re-onboard onto
   *  a data volume that survived legitimately finds the credential already seeded and must leave it
   *  alone, because the database was initialised with it and can be opened with nothing else. Every
   *  other non-2xx (a 403 policy gap, a malformed 400) still fails the run.
   *
   *  `kind` appears only in the error message, so a failure names which leaf refused. */
  private async putConsumerLeaf(addr: string, path: string, data: Record<string, string>, token: string, kind: string): Promise<VaultSeedOutcome> {
    const res = await fetch(`${addr}/v1/${KV_MOUNT}/data/${path}`, {
      method: "POST",
      headers: { "x-vault-token": token, "content-type": "application/json" },
      body: JSON.stringify({ data, options: { cas: 0 } }),
    });
    if (res.ok) return { created: true };
    const detail = await res.text().catch(() => "");
    if (res.status === 400 && detail.includes("check-and-set")) return { created: false };
    throw new VaultError(`vault ${kind} seed put failed for ${KV_MOUNT}/${path} (${res.status})`, res.status);
  }

  /** METADATA delete of one per-consumer leaf, ALL versions — the offboard/purge inverse of
   *  putConsumerLeaf. It has to be the metadata path and not the data path: a data delete is SOFT and
   *  keeps version information, and a create-only (cas=0) re-seed is allowed only where none remains,
   *  so a soft delete would let the next consumer of this name silently inherit the offboarded
   *  instance's credential.
   *
   *  404 is the idempotent no-op — a retry, but also the NORMAL case of a consumer that never asked
   *  for this database at all, since offboard and purge are keyed on the consumer and carry no record
   *  of what its manifest wanted. Everything else throws: a 403 is a missing metadata-delete grant,
   *  never "already gone". */
  private async deleteConsumerLeaf(path: string, kind: string): Promise<void> {
    const { addr, token } = await this.login();
    try {
      const res = await fetch(`${addr}/v1/${KV_MOUNT}/metadata/${path}`, {
        method: "DELETE",
        headers: { "x-vault-token": token },
      });
      if (!res.ok && res.status !== 404) throw new VaultError(`vault ${kind} delete failed for ${KV_MOUNT}/${path} (${res.status})`, res.status);
    } finally {
      await this.revoke(addr, token).catch(() => undefined);
    }
  }

  private async revoke(addr: string, token: string): Promise<void> {
    const res = await fetch(`${addr}/v1/auth/token/revoke-self`, { method: "POST", headers: { "x-vault-token": token } });
    if (!res.ok) throw new VaultError(`vault token revoke-self failed (${res.status})`, res.status);
  }
}
