import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DbHandle } from "../../db/client.ts";
import { createLogger } from "../../kernel/logger.ts";
import { parseConfig } from "../../kernel/config.ts";
import { CredentialStore } from "../../security/store.ts";
import { createServer, deleteServer, openBootstrapPassword, serverCredFlags, CreateServerInput } from "./write.ts";
import { getServer, listServers } from "./read.ts";
import type { ClusterReleases } from "./cluster-marking.ts";

/** These cases are about the server rows alone: no cluster map is read for them, and no server
 *  they create is a cluster, so every projection's release reads "not a cluster yet". */
const NO_MAPS: ClusterReleases = { ok: false, reason: "this test reads no cluster map" };

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

  it("creates a bare server; notes withheld; no password → hasPassword false", async () => {
    const { db, store } = setup();
    const view = await createServer(db, store, "op_system", { name: "s5", host: "10.1.1.11", sshUser: "hostyour1", notes: "internal" });
    expect(view).toMatchObject({ name: "s5", host: "10.1.1.11", sshUser: "hostyour1", role: "slave", status: "bare", hasPassword: false, hasKey: false });
    expect(view).not.toHaveProperty("notes");
    expect(getServer(db, view.id, undefined, NO_MAPS)?.name).toBe("s5");
  });

  it("stores a bootstrap password → hasPassword true, value never surfaces, round-trips for adopt", async () => {
    const { db, store } = setup();
    const view = await createServer(db, store, "op_system", { name: "s5", host: "10.1.1.11", sshUser: "hostyour1", password: "shared-secret-xyz" });
    expect(view.hasPassword).toBe(true);
    expect(JSON.stringify(view)).not.toContain("shared-secret-xyz");

    const flags = await serverCredFlags(store);
    expect(listServers(db, flags, NO_MAPS).find((s) => s.id === view.id)?.hasPassword).toBe(true);

    const pw = await openBootstrapPassword(store, view.id, "run_x");
    expect(pw?.toString("utf8")).toBe("shared-secret-xyz");
  });

  it("deletes a bare server and purges its credentials", async () => {
    const { db, store } = setup();
    const view = await createServer(db, store, "op_system", { name: "s5", host: "10.1.1.11", sshUser: "hostyour1", password: "pw" });
    await deleteServer(db, store, "op_system", view.id);
    expect(getServer(db, view.id, undefined, NO_MAPS)).toBeUndefined();
    expect(await serverCredFlags(store)).toEqual(new Map());
  });

  it("rejects a duplicate name with a friendly error", async () => {
    const { db, store } = setup();
    await createServer(db, store, "op_system", { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" });
    await expect(createServer(db, store, "op_system", { name: "s5", host: "9.9.9.9", sshUser: "root" })).rejects.toThrow(/already exists/);
  });

  it("validates input (name charset + port range)", () => {
    expect(() => CreateServerInput.parse({ name: "Slave_5!", host: "h", sshUser: "root" })).toThrow();
    expect(() => CreateServerInput.parse({ name: "s5", host: "h", sshUser: "root", sshPort: 70000 })).toThrow();
  });
});
