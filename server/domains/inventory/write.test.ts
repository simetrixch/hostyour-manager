import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../../db/client.ts";
import { createLogger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { CredentialStore } from "../../security/store.ts";
import { createServer, deleteServer, purgeBootstrapPassword, serverCredFlags, CreateServerInput } from "./write.ts";
import { getServer } from "./read.ts";

const logger = createLogger(
  parseConfig({
    PUBLIC_URL: "https://x.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s", DATA_DIR: "/data", LOG_LEVEL: "silent", ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
    MANAGER_VERSION: "test",
  } as NodeJS.ProcessEnv),
);

describe("inventory server CRUD", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function setup(): { db: DbHandle["db"]; store: CredentialStore } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-inv-"));
    dirs.push(dir);
    const h = openDb(join(dir, "c.db"));
    handles.push(h);
    return { db: h.db, store: new CredentialStore({ db: h.db, logger }) };
  }

  it("creates a bare server; notes withheld; and it holds no credential of any kind", () => {
    const { db, store } = setup();
    const view = createServer(db, "op_system", { name: "s5", host: "10.1.1.11", sshUser: "hostyour1", notes: "internal" });
    expect(view).toMatchObject({ name: "s5", host: "10.1.1.11", sshUser: "hostyour1", role: "slave", status: "bare", hasPassword: false, hasKey: false });
    expect(view).not.toHaveProperty("notes");
    expect(getServer(db, view.id, undefined)?.name).toBe("s5");
    // Writing a machine down reaches no credential store, so nothing was sealed for it.
    void store;
  });

  it("REFUSES a credential offered with the row, rather than dropping it silently", () => {
    // Adding a server records where a machine is. A password of the machine account is a run secret
    // the operator enters on the approve card of the run that needs it, so a caller sending one here
    // is told the field does not exist — the schema is strict, and a quietly ignored credential is
    // how a caller comes to believe something was stored.
    expect(() => CreateServerInput.parse({ name: "s5", host: "10.1.1.11", sshUser: "hostyour1", password: "shared-secret-xyz" }))
      .toThrow(/password/);
  });

  it("deletes a bare server and purges the credentials a run sealed for it", async () => {
    const { db, store } = setup();
    const view = createServer(db, "op_system", { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" });
    // The credential a machine really carries is the key a deployment installs, sealed by the run
    // and never by this surface.
    await store.seal({
      kind: "ssh_key", label: `SSH key for ${view.name}`, plaintext: Buffer.from("private"),
      fingerprint: "SHA256:managerkey", serverId: view.id, publicKey: "ssh-ed25519 AAAAkey hostyour:s5",
    });
    expect((await serverCredFlags(store)).get(view.id)?.hasKey).toBe(true);

    await deleteServer(db, store, "op_system", view.id);
    expect(getServer(db, view.id, undefined)).toBeUndefined();
    expect(await serverCredFlags(store)).toEqual(new Map());
  });

  it("purges a password sealed beside a row before this surface stopped sealing one, and says whether there was one", async () => {
    // The rows that still hold such a blob: a working way into the machine that outlives the
    // machine's own configuration, which is why the run kinds that shut a password door destroy it.
    // Idempotent, so a machine that carries none is answered rather than failed.
    const { db, store } = setup();
    const view = createServer(db, "op_system", { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" });
    expect(await purgeBootstrapPassword(store, view.id)).toBe(false);
    await store.seal({
      kind: "other", label: `password for ${view.name}`, plaintext: Buffer.from("shared-secret-xyz"),
      fingerprint: "bootstrap-password", serverId: view.id,
    });
    expect((await serverCredFlags(store)).get(view.id)?.hasPassword).toBe(true);
    expect(await purgeBootstrapPassword(store, view.id)).toBe(true);
    expect((await serverCredFlags(store)).get(view.id)?.hasPassword).toBeUndefined();
  });

  it("rejects a duplicate name with a friendly error", () => {
    const { db } = setup();
    createServer(db, "op_system", { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" });
    expect(() => createServer(db, "op_system", { name: "s5", host: "9.9.9.9", sshUser: "root" })).toThrow(/already exists/);
  });

  it("validates input (name charset + port range)", () => {
    expect(() => CreateServerInput.parse({ name: "Slave_5!", host: "h", sshUser: "root" })).toThrow();
    expect(() => CreateServerInput.parse({ name: "s5", host: "h", sshUser: "root", sshPort: 70000 })).toThrow();
  });
});
