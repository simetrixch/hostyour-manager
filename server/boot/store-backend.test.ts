import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { openDb, type DbHandle } from "../db/client.ts";
import { parseConfig } from "../kernel/config.ts";
import { CredentialStore } from "../security/store.ts";
import { storeBackend } from "./store-backend.ts";

// WHAT THE CREDENTIAL STORE'S MODE CAN BE ON A MACHINE, which is the fact three deleted plan guards
// rested on. Each of them asked whether `keystore.mode` is `plaintext` and returned unless it was.
// If a booted manager could ever be `plaintext`, deleting them took a refusal away; if it cannot,
// they were checks that could not go red. This file is what keeps that answer from drifting in
// silence, because nothing else would notice.
//
// `plaintext` still EXISTS as a mode: it is what a test that builds the store with neither
// dependency gets, and the planted case below is exactly that. What may not exist is a way for the
// configuration to produce it.

const logger = pino({ level: "silent" });

const base = {
  PUBLIC_URL: "https://m1.example",
  OIDC_ISSUER: "https://idp.example/",
  OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test",
  ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
  LOG_LEVEL: "silent",
};

describe("which backend the credential store is given, and what mode follows", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): { db: DbHandle; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-sb-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    return { db, dir };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a configuration naming a Vault address gives a Vault client, and the store records `vault`", () => {
    const { db, dir } = fresh();
    const config = parseConfig({
      ...base, DATA_DIR: dir,
      VAULT_ADDR: "https://vault.m1.example", VAULT_K8S_AUTH_MOUNT: "kubernetes-m1",
    } as NodeJS.ProcessEnv);

    const store = new CredentialStore({ db: db.db, logger, ...storeBackend(config) });

    expect(store.mode()).toBe("vault");
  });

  it("a configuration naming none gives a data key, and the store records `keyfile`", () => {
    const { db, dir } = fresh();
    const config = parseConfig({ ...base, DATA_DIR: dir } as NodeJS.ProcessEnv);

    const store = new CredentialStore({ db: db.db, logger, ...storeBackend(config) });

    expect(store.mode()).toBe("keyfile");
    // The key is on disk where losing it makes every sealed credential unreadable — read back so
    // "keyfile" means a key exists rather than that a word was written into a table.
    expect(readFileSync(join(dir, "credstore.key")).length).toBe(32);
  });

  it("PLANTED DEFECT: a store built with NEITHER records `plaintext`, which is what no configuration may produce", () => {
    // The counter-probe of the two cases above. Without it, "storeBackend always answers one of the
    // two" and "the store cannot be plaintext at all" would be the same green, and the mode the
    // deleted guards keyed on would look unreachable for the wrong reason.
    const { db } = fresh();

    const store = new CredentialStore({ db: db.db, logger });

    expect(store.mode()).toBe("plaintext");
  });

  it("storeBackend answers exactly one of the two, whatever the configuration says", () => {
    const { dir } = fresh();
    const withVault = parseConfig({
      ...base, DATA_DIR: dir,
      VAULT_ADDR: "https://vault.m1.example", VAULT_K8S_AUTH_MOUNT: "kubernetes-m1",
    } as NodeJS.ProcessEnv);
    const withoutVault = parseConfig({ ...base, DATA_DIR: dir } as NodeJS.ProcessEnv);

    for (const backend of [storeBackend(withVault), storeBackend(withoutVault)]) {
      const named = Object.keys(backend);
      expect(named).toHaveLength(1);
      expect(["vault", "dataKey"]).toContain(named[0]);
    }
  });
});
