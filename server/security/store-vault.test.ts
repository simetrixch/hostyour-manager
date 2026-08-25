import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../db/client.ts";
import { createLogger } from "../kernel/logger.ts";
import { parseConfig } from "../kernel/config.ts";
import { CredentialStore } from "./store.ts";
import { credentials } from "../db/schema/credentials.ts";
import { servers } from "../db/schema/inventory.ts";
import type { VaultKv } from "../adapters/vault/port.ts";

const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s", DATA_DIR: "/data", LOG_LEVEL: "silent",
    MANAGER_VERSION: "test",
  } as NodeJS.ProcessEnv),
);

// In-memory Vault KV double (no HTTP).
class FakeVault implements VaultKv {
  readonly kv = new Map<string, string>();
  put(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
    return Promise.resolve();
  }
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.kv.get(key));
  }
  delete(key: string): Promise<void> {
    this.kv.delete(key);
    return Promise.resolve();
  }
}

describe("CredentialStore — vault mode (values in Vault KV)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function db(): DbHandle["db"] {
    const dir = mkdtempSync(join(tmpdir(), "mgr-vault-"));
    dirs.push(dir);
    const h = openDb(join(dir, "c.db"));
    handles.push(h);
    return h.db;
  }

  it("stores the VALUE in Vault (only a reference in SQLite) and round-trips; list uses SQLite", async () => {
    const d = db();
    const vault = new FakeVault();
    const store = new CredentialStore({ db: d, logger, vault });
    expect(store.mode()).toBe("vault");

    d.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "hostyour1" }).run();
    const secret = "sesame-open-1234";
    const ref = await store.seal({ kind: "other", label: "pw", plaintext: Buffer.from(secret, "utf8"), fingerprint: "bootstrap-password", serverId: "srv_1" });

    const row = d.select().from(credentials).where(eq(credentials.id, ref.id)).get();
    expect(row?.encryptedBlob).toBe(`vault:v1:${ref.id}`);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(vault.kv.get(ref.id)).toBe(Buffer.from(secret, "utf8").toString("base64"));

    expect((await store.open(ref.id, { purpose: "test" })).toString("utf8")).toBe(secret);

    const list = await store.list({ serverId: "srv_1" });
    expect(list.map((c) => c.kind)).toEqual(["other"]);
  });

  it("purge removes the value from Vault AND the metadata row", async () => {
    const d = db();
    const vault = new FakeVault();
    const store = new CredentialStore({ db: d, logger, vault });
    const ref = await store.seal({ kind: "other", label: "x", plaintext: Buffer.from("secret", "utf8"), fingerprint: "f" });
    await store.purge(ref.id);
    expect(vault.kv.size).toBe(0);
    expect(d.select().from(credentials).where(eq(credentials.id, ref.id)).get()).toBeUndefined();
  });

  it("open throws when the value vanished from Vault", async () => {
    const d = db();
    const vault = new FakeVault();
    const store = new CredentialStore({ db: d, logger, vault });
    const ref = await store.seal({ kind: "other", label: "x", plaintext: Buffer.from("secret", "utf8"), fingerprint: "f" });
    vault.kv.clear();
    await expect(store.open(ref.id, { purpose: "t" })).rejects.toThrow(/missing from Vault/);
  });
});
