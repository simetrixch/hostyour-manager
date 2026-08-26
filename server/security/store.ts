import { eq, and, isNull } from "drizzle-orm";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Db } from "../db/client.ts";
import type { Logger } from "../kernel/logger.ts";
import { credentials } from "../db/schema/credentials.ts";
import { meta } from "../db/schema/meta.ts";
import { writeAudit } from "../db/audit-writer.ts";
import { credId } from "../kernel/ids.ts";
import { now } from "../kernel/clock.ts";
import { currentActor } from "../kernel/actor.ts";
import { AppError, errNotFound } from "../kernel/errors.ts";
import type { CredentialKind } from "../../shared/enums.ts";
import type { VaultKv } from "../adapters/vault/port.ts";

export type KeystoreMode = "plaintext" | "passphrase" | "keyfile" | "vault";

export interface CredentialRef {
  id: string;
  kind: CredentialKind;
  label: string;
  fingerprint: string;
  serverId?: string;
  publicKey?: string;
}

export interface UseContext {
  purpose: string; // "adopt:verify-key-login"
  runId?: string;
}

export interface SealInput {
  kind: CredentialKind;
  label: string;
  plaintext: Buffer;
  fingerprint: string;
  serverId?: string;
  publicKey?: string;
}

// Self-describing blob prefixes. "plain:v0:" = the plaintext pass-through (no data key). "v1:" =
// keyfile mode — AES-256-GCM, base64(iv[12] ‖ tag[16] ‖ ciphertext) under a local data key
// (KeystoreMode "keyfile"). open() reads both, so a plaintext DB
// upgrades transparently to keyfile as credentials are re-sealed. (Full XChaCha20 + passphrase
// KEK is the later "passphrase" mode.)
const PLAINTEXT_PREFIX = "plain:v0:";
const V1_PREFIX = "v1:";
// "vault" mode: the SQLite blob is only a REFERENCE — the secret value lives in Vault
// KV under this id. Metadata (kind/label/fingerprint/serverId/revoked) still rides in SQLite for
// fast list queries; Vault handles encryption-at-rest + audit for the values themselves.
const VAULT_REF_PREFIX = "vault:v1:";

function toRef(row: typeof credentials.$inferSelect): CredentialRef {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    fingerprint: row.fingerprint,
    ...(row.serverId ? { serverId: row.serverId } : {}),
    ...(row.publicKey ? { publicKey: row.publicKey } : {}),
  };
}

/**
 * The credential store. While the keystore is plaintext, seal/open are a
 * pass-through: no key, no unlock ceremony. The API shape does not depend on the mode, so a caller
 * written against it keeps working when the mode changes underneath it. No envelope lifecycle
 * exists yet — there is no init, no unlock-with-passphrase and no rekey, and boot always comes up
 * unlocked.
 */
export class CredentialStore {
  private readonly db: Db;
  private readonly logger: Logger;
  private readonly dataKey: Buffer | undefined; // 32 bytes ⇒ keyfile mode; undefined ⇒ plaintext
  private readonly vault: VaultKv | undefined; // set ⇒ vault mode (values in Vault KV)

  constructor(deps: { db: Db; logger: Logger; dataKey?: Buffer; vault?: VaultKv }) {
    this.db = deps.db;
    this.logger = deps.logger;
    if (deps.dataKey && deps.dataKey.length !== 32) throw new AppError("INTERNAL", "credential-store data key must be 32 bytes");
    this.dataKey = deps.dataKey;
    this.vault = deps.vault;
    // keystore.mode drives the UI banner (store.mode_banner self-check) and the crypto
    // gate. vault when Vault is the backend (prod); else keyfile when a data key is
    // loaded; else plaintext (tests).
    const keystoreMode: KeystoreMode = deps.vault ? "vault" : deps.dataKey ? "keyfile" : "plaintext";
    this.db
      .insert(meta)
      .values({ key: "keystore.mode", value: keystoreMode })
      .onConflictDoUpdate({ target: meta.key, set: { value: keystoreMode } })
      .run();
  }

  mode(): KeystoreMode {
    const row = this.db.select().from(meta).where(eq(meta.key, "keystore.mode")).get();
    return (row?.value as KeystoreMode | undefined) ?? "plaintext";
  }

  isUnlocked(): boolean {
    return true; // keyfile/plaintext: the key is loaded at boot, no unlock ceremony (that's "passphrase")
  }

  private encrypt(plain: Buffer): string {
    if (!this.dataKey) throw new AppError("INTERNAL", "encrypt called without a data key");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.dataKey, iv);
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return V1_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  }

  private decrypt(blob: string): Buffer {
    if (!this.dataKey) throw new AppError("INTERNAL", "credential is keyfile-encrypted but no data key is loaded");
    const raw = Buffer.from(blob.slice(V1_PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const decipher = createDecipheriv("aes-256-gcm", this.dataKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  }

  /** Seal plaintext, insert the row, audit credential.created, and zero the input. */
  async seal(input: SealInput): Promise<CredentialRef> {
    const id = credId();
    let blob: string;
    if (this.vault) {
      await this.vault.put(id, input.plaintext.toString("base64"));
      blob = VAULT_REF_PREFIX + id;
    } else if (this.dataKey) {
      blob = this.encrypt(input.plaintext);
    } else {
      blob = PLAINTEXT_PREFIX + input.plaintext.toString("base64");
    }
    this.db
      .insert(credentials)
      .values({
        id,
        kind: input.kind,
        label: input.label,
        serverId: input.serverId ?? null,
        encryptedBlob: blob,
        fingerprint: input.fingerprint,
        publicKey: input.publicKey ?? null,
      })
      .run();
    input.plaintext.fill(0); // wipe the caller's buffer now that the row is written
    // Every audit row here names the signed-in operator whose request performed the act;
    // "system" only for work no request drove (boot seeding, resume).
    writeAudit(this.db, {
      actor: currentActor() ?? "system",
      action: "credential.created",
      targetKind: "credential",
      targetId: id,
      detail: { kind: input.kind, fingerprint: input.fingerprint },
    });
    this.logger.debug({ id, kind: input.kind, fingerprint: input.fingerprint }, "credential sealed");
    return {
      id,
      kind: input.kind,
      label: input.label,
      fingerprint: input.fingerprint,
      ...(input.serverId ? { serverId: input.serverId } : {}),
      ...(input.publicKey ? { publicKey: input.publicKey } : {}),
    };
  }

  /** Decrypt for use; audits credential.used. The caller MUST zero the returned Buffer
   *  (helper: withOpened). Throws on a missing or revoked credential. */
  async open(id: string, use: UseContext): Promise<Buffer> {
    const row = this.db.select().from(credentials).where(eq(credentials.id, id)).get();
    if (!row) throw errNotFound(`credential ${id} not found`);
    if (row.revokedAt !== null) throw new AppError("NOT_FOUND", `credential ${id} is revoked`);
    let plain: Buffer;
    if (row.encryptedBlob.startsWith(VAULT_REF_PREFIX)) {
      if (!this.vault) throw new AppError("INTERNAL", `credential ${id} lives in Vault but no Vault backend is configured`);
      const value = await this.vault.get(row.encryptedBlob.slice(VAULT_REF_PREFIX.length));
      if (value === undefined) throw new AppError("NOT_FOUND", `credential ${id} value missing from Vault`);
      plain = Buffer.from(value, "base64");
    } else if (row.encryptedBlob.startsWith(V1_PREFIX)) {
      plain = this.decrypt(row.encryptedBlob);
    } else if (row.encryptedBlob.startsWith(PLAINTEXT_PREFIX)) {
      plain = Buffer.from(row.encryptedBlob.slice(PLAINTEXT_PREFIX.length), "base64");
    } else {
      throw new AppError("INTERNAL", `credential ${id} has an unrecognized blob format`);
    }
    this.db.update(credentials).set({ lastUsedAt: new Date(now()) }).where(eq(credentials.id, id)).run();
    writeAudit(this.db, {
      actor: currentActor() ?? "system",
      action: "credential.used",
      targetKind: "credential",
      targetId: id,
      ...(use.runId ? { runId: use.runId } : {}),
      detail: { purpose: use.purpose, fingerprint: row.fingerprint },
    });
    return plain;
  }

  /** Preferred shape: open, hand the Buffer to fn, memzero in finally. */
  async withOpened<T>(id: string, use: UseContext, fn: (plain: Buffer) => Promise<T>): Promise<T> {
    const buf = await this.open(id, use);
    try {
      return await fn(buf);
    } finally {
      buf.fill(0);
    }
  }

  /** New blob for the same logical credential; sets rotated_at on the old row. */
  async rotate(oldId: string, next: { plaintext: Buffer; fingerprint: string; publicKey?: string }): Promise<CredentialRef> {
    const old = this.db.select().from(credentials).where(eq(credentials.id, oldId)).get();
    if (!old) throw errNotFound(`credential ${oldId} not found`);
    const ref = await this.seal({
      kind: old.kind,
      label: old.label,
      plaintext: next.plaintext,
      fingerprint: next.fingerprint,
      ...(old.serverId ? { serverId: old.serverId } : {}),
      ...(next.publicKey ? { publicKey: next.publicKey } : {}),
    });
    this.db.update(credentials).set({ rotatedAt: new Date(now()) }).where(eq(credentials.id, oldId)).run();
    writeAudit(this.db, {
      actor: currentActor() ?? "system",
      action: "credential.rotated",
      targetKind: "credential",
      targetId: ref.id,
      detail: { supersedes: oldId, fingerprint: next.fingerprint },
    });
    return ref;
  }

  /** Soft revoke: sets revoked_at (blob kept for audit). open() then throws. */
  async revoke(id: string, reason: string): Promise<void> {
    const row = this.db.select().from(credentials).where(eq(credentials.id, id)).get();
    if (!row) throw errNotFound(`credential ${id} not found`);
    this.db.update(credentials).set({ revokedAt: new Date(now()) }).where(eq(credentials.id, id)).run();
    writeAudit(this.db, {
      actor: currentActor() ?? "system",
      action: "credential.revoked",
      targetKind: "credential",
      targetId: id,
      detail: { reason },
    });
  }

  /** HARD-delete a credential row — the plaintext blob is removed, not just revoked
   *. Used to fully remove a not-yet-adopted server. Audited. Idempotent. */
  async purge(id: string): Promise<void> {
    const row = this.db.select().from(credentials).where(eq(credentials.id, id)).get();
    if (!row) return;
    if (row.encryptedBlob.startsWith(VAULT_REF_PREFIX) && this.vault) {
      await this.vault.delete(row.encryptedBlob.slice(VAULT_REF_PREFIX.length));
    }
    this.db.delete(credentials).where(eq(credentials.id, id)).run();
    writeAudit(this.db, {
      actor: currentActor() ?? "system",
      action: "credential.purged",
      targetKind: "credential",
      targetId: id,
      detail: { kind: row.kind, fingerprint: row.fingerprint },
    });
  }

  /** Active (non-revoked) credentials matching the filter, ordered oldest→newest by createdAt
   *  so `.at(-1)` is DETERMINISTICALLY the newest (callers rely on this to pick "the newest key";
   *  a bare table scan had no defined order). createdAt is a millisecond DB-clock default
   *  (`unixepoch('subsec') * 1000`) — two seal()/rotate() calls close enough together (a rotate
   *  right after a seal, a loaded box under test-suite contention) CAN land in the same
   *  millisecond, and createdAt alone ties; ORDER BY on a tie is undefined, not "insertion
   *  order". `id` breaks it: kernel/ids.ts mints a monotonic ULID, so within any tied createdAt
   *  group the row sealed later always carries the larger id.
   *
   *  SQLite's own `rowid` would break the same tie and would do it across processes, which the id
   *  cannot — one factory per process is the whole of its guarantee. It is not used, because it
   *  never leaves the query: rowid is not selected onto the CredentialRef a caller is handed, so a
   *  caller sorting rows it already holds, an operator typing ORDER BY id, and an export all sit
   *  outside it and would each need their own answer. The id travels with the row, so there is one.
   *
   *  `excludeRotated` additionally drops superseded rows (rotatedAt set) so "newest ACTIVE key" is
   *  exact — off by default to keep every existing caller's behavior unchanged (they either count
   *  presence or run their own rotate bookkeeping over the rotated rows). */
  async list(filter?: { serverId?: string; kind?: CredentialKind; excludeRotated?: boolean }): Promise<CredentialRef[]> {
    const conds = [isNull(credentials.revokedAt)];
    if (filter?.serverId) conds.push(eq(credentials.serverId, filter.serverId));
    if (filter?.kind) conds.push(eq(credentials.kind, filter.kind));
    if (filter?.excludeRotated) conds.push(isNull(credentials.rotatedAt));
    const rows = this.db.select().from(credentials).where(and(...conds)).orderBy(credentials.createdAt, credentials.id).all();
    return rows.map(toRef);
  }

  /** Reset support: the Vault KV ref ids referenced by ANY credential row (revoked included).
   *  Read-only — the rows themselves fall in the wipe transaction (db/reset.ts). Empty unless
   *  Vault is the backend (plaintext/keyfile stores keep the value inline, nothing to clean up). */
  collectVaultRefs(): string[] {
    if (!this.vault) return [];
    return this.db.select().from(credentials).all()
      .filter((r) => r.encryptedBlob.startsWith(VAULT_REF_PREFIX))
      .map((r) => r.encryptedBlob.slice(VAULT_REF_PREFIX.length));
  }

  /** Best-effort Vault cleanup AFTER the wipe committed (the rows are already gone). Never throws.
   *  Returns the KV ref ids that could NOT be deleted — an orphaned value is not "harmless" (it may
   *  be a live private SSH key), so it is surfaced to the operator to delete by hand, never a
   *  silent swallow. Values themselves are never logged. */
  async deleteVaultValues(ids: string[]): Promise<string[]> {
    if (!this.vault) return [];
    const orphans: string[] = [];
    for (const id of ids) {
      try {
        await this.vault.delete(id);
      } catch (err) {
        orphans.push(id);
        this.logger.warn({ ref: id, err: err instanceof Error ? err.message : String(err) },
          "reset: Vault value NOT deleted — orphaned credential value, delete this KV ref by hand");
      }
    }
    return orphans;
  }
}
