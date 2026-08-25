import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/client.ts";
import { createLogger } from "../kernel/logger.ts";
import { parseConfig } from "../kernel/config.ts";
import { CredentialStore } from "./store.ts";
import { runAsActor } from "../kernel/actor.ts";

const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://m1.example",
    OIDC_ISSUER: "https://idp.example/",
    OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s",
    MANAGER_VERSION: "test",
    DATA_DIR: "/data",
    LOG_LEVEL: "silent",
  } as NodeJS.ProcessEnv),
);

describe("CredentialStore (plaintext pass-through)", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  function fresh() {
    const dir = mkdtempSync(join(tmpdir(), "mgr-store-"));
    dirs.push(dir);
    const handle = openDb(join(dir, "manager.db"));
    closers.push(() => handle.sqlite.close());
    return { store: new CredentialStore({ db: handle.db, logger }), sqlite: handle.sqlite };
  }
  afterEach(() => {
    for (const c of closers.splice(0)) c(); // close DB handles before rm (Windows file lock)
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("sets keystore.mode=plaintext on construction and boots unlocked", () => {
    const { store, sqlite } = fresh();
    expect(store.mode()).toBe("plaintext");
    expect(store.isUnlocked()).toBe(true);
    const row = sqlite.prepare("SELECT value FROM meta WHERE key='keystore.mode'").get() as { value: string };
    expect(row.value).toBe("plaintext");
  });

  it("seal → open round-trips and zeroes the input buffer", async () => {
    const { store } = fresh();
    const plain = Buffer.from("super-secret-key-material");
    const copy = Buffer.from(plain);
    const ref = await store.seal({ kind: "pat", label: "test PAT", plaintext: plain, fingerprint: "sha256:abc" });
    expect(plain.every((b) => b === 0)).toBe(true); // memzeroed
    const opened = await store.open(ref.id, { purpose: "test" });
    expect(opened.equals(copy)).toBe(true);
  });

  it("audits seal/open with the request's operator when one is bound, else 'system'", async () => {
    const { store, sqlite } = fresh();
    // Inside a request the chokepoint binds the operator (kernel/actor.ts); the store's audit rows
    // must name that human. Outside any request (boot seeding, resume) they stay "system".
    const ref = await runAsActor("op_a", () => store.seal({ kind: "pat", label: "x", plaintext: Buffer.from("secret-value"), fingerprint: "sha256:a" }));
    await runAsActor("op_a", () => store.open(ref.id, { purpose: "test" }));
    const actors = (sqlite.prepare("SELECT actor, action FROM audit WHERE target_id=? ORDER BY ts").all(ref.id) as { actor: string; action: string }[]);
    expect(actors.map((a) => [a.action, a.actor])).toEqual([["credential.created", "op_a"], ["credential.used", "op_a"]]);
    const boot = await store.seal({ kind: "pat", label: "y", plaintext: Buffer.from("secret-value"), fingerprint: "sha256:b" });
    const row = sqlite.prepare("SELECT actor FROM audit WHERE target_id=? AND action='credential.created'").get(boot.id) as { actor: string };
    expect(row.actor).toBe("system");
  });

  it("open on a revoked credential throws; the blob is kept for audit", async () => {
    const { store, sqlite } = fresh();
    const ref = await store.seal({ kind: "pat", label: "x", plaintext: Buffer.from("secret-value"), fingerprint: "sha256:def" });
    await store.revoke(ref.id, "compromised");
    await expect(store.open(ref.id, { purpose: "test" })).rejects.toThrow();
    const row = sqlite.prepare("SELECT encrypted_blob, revoked_at FROM credentials WHERE id=?").get(ref.id) as {
      encrypted_blob: string;
      revoked_at: number | null;
    };
    expect(row.encrypted_blob.length).toBeGreaterThan(0);
    expect(row.revoked_at).not.toBeNull();
  });

  it("rotate keeps the logical credential and sets rotated_at on the old row", async () => {
    const { store, sqlite } = fresh();
    const first = await store.seal({ kind: "ssh_key", label: "s5 key", plaintext: Buffer.from("old-key"), fingerprint: "SHA256:aaa", publicKey: "ssh-ed25519 AAA old" });
    const second = await store.rotate(first.id, { plaintext: Buffer.from("new-key"), fingerprint: "SHA256:bbb", publicKey: "ssh-ed25519 BBB new" });
    expect(second.id).not.toBe(first.id);
    const old = sqlite.prepare("SELECT rotated_at FROM credentials WHERE id=?").get(first.id) as { rotated_at: number | null };
    expect(old.rotated_at).not.toBeNull();
    const opened = await store.open(second.id, { purpose: "test" });
    expect(opened.toString()).toBe("new-key");
  });

  it("the same fingerprint may be sealed on more than one row (correlator, not a key)", async () => {
    // The live create-mgmt incident class: a slave's STABLE long-lived token re-sealed under
    // a renamed label collided with the old global credentials_fingerprint_uq (migration
    // 0005 dropped it). Same shape: the constant "bootstrap-password" marker fingerprint
    // shared by every server with a stored adopt password.
    const { store } = fresh();
    const a = await store.seal({ kind: "kubeconfig", label: "edge1 cluster bearer (argocd-manager) — s1", plaintext: Buffer.from("stable-token"), fingerprint: "sha256:same" });
    const b = await store.seal({ kind: "kubeconfig", label: "s1 cluster bearer (argocd-manager)", plaintext: Buffer.from("stable-token"), fingerprint: "sha256:same" });
    expect(b.id).not.toBe(a.id);
    expect((await store.list()).map((r) => r.fingerprint)).toEqual(["sha256:same", "sha256:same"]);
  });

  it("list returns active credentials only and writes the audit trail", async () => {
    const { store, sqlite } = fresh();
    const a = await store.seal({ kind: "pat", label: "a", plaintext: Buffer.from("aaaa"), fingerprint: "sha256:a" });
    await store.seal({ kind: "pat", label: "b", plaintext: Buffer.from("bbbb"), fingerprint: "sha256:b" });
    await store.revoke(a.id, "x");
    const active = await store.list();
    expect(active.map((r) => r.label)).toEqual(["b"]);
    const created = sqlite.prepare("SELECT count(*) AS n FROM audit WHERE action='credential.created'").get() as { n: number };
    const revoked = sqlite.prepare("SELECT count(*) AS n FROM audit WHERE action='credential.revoked'").get() as { n: number };
    expect(created.n).toBe(2);
    expect(revoked.n).toBe(1);
  });
});
