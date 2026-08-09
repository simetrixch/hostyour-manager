import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../db/client.ts";
import { createLogger } from "../kernel/logger.ts";
import { parseConfig } from "../kernel/config.ts";
import { CredentialStore } from "./store.ts";
import { credentials } from "../db/schema/credentials.ts";

const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s", DATA_DIR: "/data", LOG_LEVEL: "silent",
    CONTROLLER_VERSION: "test",
  } as NodeJS.ProcessEnv),
);

describe("CredentialStore — keyfile mode (AES-256-GCM at rest)", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function db(): DbHandle["db"] {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-ks-"));
    dirs.push(dir);
    const h = openDb(join(dir, "c.db"));
    handles.push(h);
    return h.db;
  }

  it("keyfile mode seals encrypted (v1:) — the plaintext is never in the DB — and round-trips", async () => {
    const d = db();
    const store = new CredentialStore({ db: d, logger, dataKey: randomBytes(32) });
    expect(store.mode()).toBe("keyfile");

    const secret = "sesame-open-1234";
    const ref = await store.seal({ kind: "other", label: "pw", plaintext: Buffer.from(secret, "utf8"), fingerprint: "bootstrap-password" });
    const row = d.select().from(credentials).where(eq(credentials.id, ref.id)).get();
    expect(row?.encryptedBlob.startsWith("v1:")).toBe(true);
    expect(row?.encryptedBlob).not.toContain(secret);
    expect(row?.encryptedBlob).not.toContain(Buffer.from(secret, "utf8").toString("base64"));

    expect((await store.open(ref.id, { purpose: "test" })).toString("utf8")).toBe(secret);
  });

  it("plaintext mode (no data key) keeps the plain:v0: format and reads it", async () => {
    const d = db();
    const store = new CredentialStore({ db: d, logger });
    expect(store.mode()).toBe("plaintext");
    const ref = await store.seal({ kind: "other", label: "x", plaintext: Buffer.from("hi", "utf8"), fingerprint: "f" });
    const row = d.select().from(credentials).where(eq(credentials.id, ref.id)).get();
    expect(row?.encryptedBlob.startsWith("plain:v0:")).toBe(true);
    expect((await store.open(ref.id, { purpose: "t" })).toString("utf8")).toBe("hi");
  });

  it("a tampered ciphertext fails the GCM auth check on open", async () => {
    const d = db();
    const key = randomBytes(32);
    const store = new CredentialStore({ db: d, logger, dataKey: key });
    const ref = await store.seal({ kind: "other", label: "x", plaintext: Buffer.from("secret", "utf8"), fingerprint: "f" });
    const row = d.select().from(credentials).where(eq(credentials.id, ref.id)).get();
    const flipped = `v1:${Buffer.from((row?.encryptedBlob ?? "").slice(3), "base64").fill(0).toString("base64")}`;
    d.update(credentials).set({ encryptedBlob: flipped }).where(eq(credentials.id, ref.id)).run();
    await expect(store.open(ref.id, { purpose: "t" })).rejects.toThrow();
  });

  it("rejects a data key that is not 32 bytes", () => {
    const d = db();
    expect(() => new CredentialStore({ db: d, logger, dataKey: randomBytes(16) })).toThrow(/32 bytes/);
  });
});
