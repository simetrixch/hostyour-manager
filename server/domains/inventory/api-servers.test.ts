import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { CredentialStore } from "../../security/store.ts";
import { runActor } from "../../kernel/actor.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerServerRoutes } from "./api.ts";
import { serverCredFlags } from "./write.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { ApiError, OperatorKeyView, ServerView } from "../../../shared/api-types.ts";

// registerServerRoutes (api.ts) — the six routes the server inventory screen is made of, driven
// through the real app so the chokepoint and the CSRF guard are in the path. The neighbouring
// registerClustersRoutes is covered in api.test.ts and shares the ServerView projection; what is
// exercised HERE is the half that projection never sees: the credential flags GET /api/servers folds
// in (api.ts, serverCredFlags) and the writes.
//
// NONE of these routes reaches a machine, and none plans a run, which is why this harness needs no
// executor and no ssh factory: every act that touches a host is planned through POST /api/runs.

const config = parseConfig({
  PUBLIC_URL: "https://m1.example",
  OIDC_ISSUER: "https://i.example/",
  OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test",
  DATA_DIR: "/d",
  ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);

const MASTER = "m1.example.com";
const SLAVE = "s1.example.com";

const OPERATOR_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorPatKeyAAAAAAAAAAAAAAAAAAAAAAAAAA pat@example.com";

interface Harness {
  app: Hono<AppEnv>;
  db: DbHandle;
  store: CredentialStore;
  cookie: string;
}

describe("server inventory API", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];

  async function make(): Promise<Harness> {
    const dir = mkdtempSync(join(tmpdir(), "mgr-servers-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    // The chokepoint attributes every write to the session's sub, and runs.started_by is an FK onto
    // operators — in production upsertOperator wrote that row at login; the harness mints the cookie
    // directly, so it seeds the row itself.
    db.sqlite.prepare("INSERT INTO operators (id, username, display_name) VALUES ('op_test', 'test', 'Test')").run();
    const store = new CredentialStore({ db: db.db, logger });
    const session = new SessionCodec(db.db, config);
    const app = createApp({
      config,
      logger,
      getReadiness: () => ({ ok: true, checks: [] }),
      session,
      registerAuth: () => undefined,
      registerProtected: (a) =>
        registerServerRoutes(a, { db: db.db, creds: store, actor: runActor }),
    });
    const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
    return { app, db, store, cookie };
  }

  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });

  /** A mutating request as the browser sends it: the session cookie plus the same-origin header the
   *  CSRF guard (http/middleware/csrf.ts) demands on POST and DELETE. `csrf: false` drops that header
   *  to drive the refusal. */
  async function mutate(app: Hono<AppEnv>, method: "POST" | "DELETE", path: string, cookie: string, body?: unknown, csrf = true): Promise<Response> {
    const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${cookie}` };
    if (csrf) headers["sec-fetch-site"] = "same-origin";
    if (body !== undefined) headers["content-type"] = "application/json";
    return app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }

  async function listServersOverHttp(h: Harness): Promise<ServerView[]> {
    const res = await h.app.request("/api/servers", authed(h.cookie));
    expect(res.status).toBe(200);
    return ((await res.json()) as { servers: ServerView[] }).servers;
  }

  /** A master and a slave, both registered as clusters, plus a bare machine that is no cluster. */
  function seedThree(db: DbHandle): void {
    for (const [id, name, role, cls, domain] of [
      ["srv_m", "m1", "master", "cls_m", MASTER],
      ["srv_s", "s1", "slave", "cls_s", SLAVE],
    ] as const) {
      db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role, status) VALUES (?,?,?,'root',?,'healthy')").run(id, name, domain, role);
      db.sqlite.prepare("INSERT INTO clusters (id, server_id, stage, domain) VALUES (?,?,'prod',?)").run(cls, id, domain);
    }
    db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role, status) VALUES ('srv_b','b1','203.0.113.9','root','slave','bare')").run();
  }

  describe("GET /api/servers", () => {
    it("→ 200 with an empty list on a fresh DB", async () => {
      const h = await make();
      expect(await listServersOverHttp(h)).toEqual([]);
    });

    it("carries the MASTER row, which /api/clusters withholds from its servers array", async () => {
      // buildClustersView (api.ts) filters the master out of ClustersView.servers because the
      // manager does not manage itself. This route is the inventory and lists every row, so the
      // master is here — sorted first (read.ts:85).
      const h = await make();
      seedThree(h.db);
      const servers = await listServersOverHttp(h);
      expect(servers.map((s) => s.id)).toEqual(["srv_m", "srv_b", "srv_s"]);
      expect(servers[0]?.role).toBe("master");
    });

    it("folds in the credential flags a RUN sealed, and no credential's value ever crosses", async () => {
      // The flags are read off the credential store and never off this route's input: adding a
      // server seals nothing, so both rows below start with neither flag and what makes one of them
      // differ is a credential sealed the way a run seals one.
      const h = await make();
      const created = await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" });
      expect(created.status).toBe(201);
      const { server } = (await created.json()) as { server: ServerView };
      expect(server).toMatchObject({ hasPassword: false, hasKey: false });
      await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s6", host: "10.1.1.12", sshUser: "hostyour1" });
      await h.store.seal({
        kind: "ssh_key", label: "SSH key for s5", plaintext: Buffer.from("private-key-material"),
        fingerprint: "SHA256:managerkey", serverId: server.id, publicKey: "ssh-ed25519 AAAAkey hostyour:s5",
      });
      // A row sealed a password before this surface stopped taking one still holds a working way in,
      // so the flag that says so must go on being reported.
      await h.store.seal({
        kind: "other", label: "password for s5", plaintext: Buffer.from("shared-secret-xyz"),
        fingerprint: "bootstrap-password", serverId: server.id,
      });

      const res = await h.app.request("/api/servers", authed(h.cookie));
      const body = await res.text();
      const servers = (JSON.parse(body) as { servers: ServerView[] }).servers;
      expect(servers.find((s) => s.name === "s5")).toMatchObject({ hasPassword: true, hasKey: true });
      // The counter-probe on the flags: the machine nothing was sealed for must not inherit the
      // neighbouring one's.
      expect(servers.find((s) => s.name === "s6")).toMatchObject({ hasPassword: false, hasKey: false });
      expect(body).not.toContain("shared-secret-xyz");
      expect(body).not.toContain("private-key-material");
    });

    it("withholds what the projection is the trust boundary for — notes never cross", async () => {
      const h = await make();
      await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "10.1.1.11", sshUser: "hostyour1", notes: "rack-4 secret-notes" });
      const body = await (await h.app.request("/api/servers", authed(h.cookie))).text();
      expect(body).not.toContain("secret-notes");
      expect(JSON.parse(body).servers[0]).not.toHaveProperty("notes");
    });

    it("unauthenticated → 401", async () => {
      const { app } = await make();
      expect((await app.request("/api/servers", { headers: { accept: "application/json" } })).status).toBe(401);
    });
  });

  describe("POST /api/servers", () => {
    it("→ 201 with the created row's projection, which the list then carries", async () => {
      const h = await make();
      const res = await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" });
      expect(res.status).toBe(201);
      const { server } = (await res.json()) as { server: ServerView };
      expect(server).toMatchObject({ name: "s5", host: "10.1.1.11", sshUser: "hostyour1", role: "slave", status: "bare" });
      expect((await listServersOverHttp(h)).map((s) => s.id)).toEqual([server.id]);
    });

    it("attributes the write to the signed-in operator — never op_system", async () => {
      const h = await make();
      const res = await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" });
      const { server } = (await res.json()) as { server: ServerView };
      const actor = h.db.sqlite.prepare("SELECT actor FROM audit WHERE action = 'server.created' AND target_id = ?").get(server.id) as { actor: string };
      expect(actor.actor).toBe("op_test");
    });

    it("refuses a duplicate name with a 400 naming the collision", async () => {
      const h = await make();
      await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" });
      const res = await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "9.9.9.9", sshUser: "root" });
      expect(res.status).toBe(400);
      const err = (await res.json()) as ApiError;
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toContain("already exists");
    });

    it("a body that fails CreateServerInput answers 500 INTERNAL and names no field — see the note", async () => {
      // What the operator SEES today: typing 70000 into the Port field returns a generic red banner.
      // That field carries no max (web/src/pages/Servers.tsx, the sshPort input) and the same file's
      // submit handler passes Number(form.sshPort) straight through, so 70000 reaches CreateServerInput's .max(65535)
      // (write.ts:37). CreateServerInput.parse (api.ts:87) throws a ZodError, and error-shape.ts:13
      // redacts every non-AppError to INTERNAL, so which field was wrong never reaches the browser.
      // The "Slave_5!" body below is not browser-reachable: the name input in web/src/pages/Servers.tsx
      // carries pattern="[a-z0-9][a-z0-9-]*" required inside a form with no noValidate, so that name is
      // stopped before submit. Asserted as it stands rather than as it should be — this case is the
      // record that the hole is real. The last body is a field the schema does not name at all, which
      // CreateServerInput is strict about: a credential offered here is refused and never dropped.
      const h = await make();
      for (const body of [{ name: "Slave_5!", host: "h", sshUser: "root" }, { name: "s5", host: "h", sshUser: "root", sshPort: 70000 }, {},
        { name: "s5", host: "h", sshUser: "root", password: "shared-secret-xyz" }]) {
        const res = await mutate(h.app, "POST", "/api/servers", h.cookie, body);
        expect(res.status).toBe(500);
        expect((await res.json()) as ApiError).toEqual({ code: "INTERNAL", message: "Internal error" });
      }
      expect(await listServersOverHttp(h)).toEqual([]);
    });

    it("without the same-origin header → CSRF refused, and nothing is registered", async () => {
      const h = await make();
      const res = await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" }, false);
      expect(res.status).toBe(403);
      expect(((await res.json()) as ApiError).code).toBe("CSRF_REFUSED");
      expect(await listServersOverHttp(h)).toEqual([]);
    });
  });

  describe("DELETE /api/servers/:id", () => {
    it("forgets a bare server and purges the credentials sealed beside it", async () => {
      const h = await make();
      const { server } = (await (
        await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" })
      ).json()) as { server: ServerView };
      await h.store.seal({
        kind: "ssh_key", label: "SSH key for s5", plaintext: Buffer.from("private"),
        fingerprint: "SHA256:managerkey", serverId: server.id, publicKey: "ssh-ed25519 AAAAkey hostyour:s5",
      });
      expect(await serverCredFlags(h.store)).toEqual(new Map([[server.id, { hasPassword: false, hasKey: true }]]));

      const res = await mutate(h.app, "DELETE", `/api/servers/${server.id}`, h.cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await listServersOverHttp(h)).toEqual([]);
      expect(await serverCredFlags(h.store)).toEqual(new Map());
    });

    it("refuses the master, and refuses a server that carries a cluster", async () => {
      const h = await make();
      seedThree(h.db);
      const master = (await mutate(h.app, "DELETE", "/api/servers/srv_m", h.cookie)).clone();
      expect(master.status).toBe(400);
      expect(((await master.json()) as ApiError).message).toContain("cannot be deleted");

      const slave = await mutate(h.app, "DELETE", "/api/servers/srv_s", h.cookie);
      expect(slave.status).toBe(400);
      expect(((await slave.json()) as ApiError).message).toContain("remove the cluster first");
      expect((await listServersOverHttp(h)).map((s) => s.id)).toEqual(["srv_m", "srv_b", "srv_s"]);
    });

    it("an unknown id is a 400 VALIDATION, not a 404", async () => {
      const h = await make();
      const res = await mutate(h.app, "DELETE", "/api/servers/srv_nope", h.cookie);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).message).toContain("srv_nope not found");
    });
  });

  // POST /api/servers/:id/machine-identity — the statement a person makes about a machine they
  // rebuilt. Driven over HTTP rather than against the domain function, because the two things that
  // make it a statement and not a default are properties of the route: the chokepoint attributes it
  // to the operator who made it, and the CSRF guard keeps another site from making it for them.
  describe("POST /api/servers/:id/machine-identity", () => {
    /** A fingerprint of the shape a machine presents: SHA256: and 43 base64 characters. */
    const fp = (seed: string): string => `SHA256:${seed.repeat(43).slice(0, 43)}`;
    const PINNED = fp("Ab1");
    const PRESENTED = fp("Zy9");
    const MACHINE_ID = "0123456789abcdef0123456789abcdef";

    /** A slave this manager has already reached: a host key pinned, a machine-id recorded, and the
     *  preflight checks that share the document with the pin. */
    function seedReached(db: DbHandle): void {
      db.sqlite.prepare("INSERT INTO servers (id, name, host, ssh_user, role, status, machine_id, preflight_json) VALUES ('srv_r','r1','203.0.113.10','hostyour1','slave','ready',?,?)")
        .run(MACHINE_ID, JSON.stringify({ hostKey: PINNED, checkedAt: 42, checks: [] }));
    }

    /** Give a row that already stands the two numbers a machine this manager has reached carries.
     *  Used on the MASTER, whose pin comes from the deployment configuration seed-master re-reads on
     *  every boot, and whose machine-id comes from nothing but the attestation that recorded it. */
    function pinMachine(db: DbHandle, id: string): void {
      db.sqlite.prepare("UPDATE servers SET machine_id = ?, preflight_json = ? WHERE id = ?")
        .run(MACHINE_ID, JSON.stringify({ hostKey: PINNED }), id);
    }

    function identityAt(db: DbHandle, id: string): { hostKey: string | undefined; machineId: string | null } {
      const row = db.sqlite.prepare("SELECT machine_id, preflight_json FROM servers WHERE id = ?").get(id) as { machine_id: string | null; preflight_json: string };
      return { hostKey: (JSON.parse(row.preflight_json) as { hostKey?: string }).hostKey, machineId: row.machine_id };
    }

    function identityOf(db: DbHandle): { hostKey: string | undefined; checkedAt: number | undefined; machineId: string | null } {
      const row = db.sqlite.prepare("SELECT machine_id, preflight_json FROM servers WHERE id = 'srv_r'").get() as { machine_id: string | null; preflight_json: string };
      const pf = JSON.parse(row.preflight_json) as { hostKey?: string; checkedAt?: number };
      return { hostKey: pf.hostKey, checkedAt: pf.checkedAt, machineId: row.machine_id };
    }

    it("pins the stated key, forgets the machine-id beside it, and leaves the rest of the document alone", async () => {
      const h = await make();
      seedReached(h.db);
      const res = await mutate(h.app, "POST", "/api/servers/srv_r/machine-identity", h.cookie, { hostKeyFingerprint: PRESENTED });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // The machine-id goes because a rebuilt machine reports a new one: leaving it would open the
      // door and refuse the same run one step later, at the check that verifies it.
      expect(identityOf(h.db)).toEqual({ hostKey: PRESENTED, checkedAt: 42, machineId: null });
    });

    it("takes the fingerprint off a terminal, newline and all", async () => {
      const h = await make();
      seedReached(h.db);
      const res = await mutate(h.app, "POST", "/api/servers/srv_r/machine-identity", h.cookie, { hostKeyFingerprint: `  ${PRESENTED}
` });
      expect(res.status).toBe(200);
      expect(identityOf(h.db).hostKey).toBe(PRESENTED);
    });

    it("audits both numbers and the operator who stated them — the only record of why the pin moved", async () => {
      const h = await make();
      seedReached(h.db);
      await mutate(h.app, "POST", "/api/servers/srv_r/machine-identity", h.cookie, { hostKeyFingerprint: PRESENTED });
      const row = h.db.sqlite.prepare("SELECT actor, target_id, detail_json FROM audit WHERE action = 'server.machine_identity_restated'").get() as { actor: string; target_id: string; detail_json: string };
      expect(row.actor).toBe("op_test");
      expect(row.target_id).toBe("srv_r");
      expect(JSON.parse(row.detail_json)).toMatchObject({ name: "r1", hostKeyWas: PINNED, hostKeyNow: PRESENTED, machineIdDropped: MACHINE_ID });
    });

    it("refuses what is not a statement about a rebuilt machine, and writes nothing on any of them", async () => {
      const h = await make();
      seedThree(h.db);
      seedReached(h.db);
      pinMachine(h.db, "srv_m");
      // The master's pin is provisioned, not stated: seed-master reads MASTER_SSH_HOST_KEY_FP again
      // on every boot, so a value written here would not survive one.
      const master = await mutate(h.app, "POST", "/api/servers/srv_m/machine-identity", h.cookie, { hostKeyFingerprint: PRESENTED });
      expect(master.status).toBe(400);
      expect(((await master.json()) as ApiError).message).toContain("MASTER_SSH_HOST_KEY_FP");
      // A row pinning nothing has no identity to replace — the next run records what it meets. It
      // carries no machine-id either: one is only ever recorded over a session, and opening one
      // records the host key first.
      const unpinned = await mutate(h.app, "POST", "/api/servers/srv_b/machine-identity", h.cookie, { hostKeyFingerprint: PRESENTED });
      expect(unpinned.status).toBe(400);
      expect(((await unpinned.json()) as ApiError).message).toContain("no host key is recorded");
      // A value no machine can present would replace a refusal that names a real machine with one
      // that names nothing, so it is refused rather than pinned.
      for (const typed of ["SHA256:short", "256 SHA256:" + PRESENTED.slice(7) + " root@r1 (ED25519)", PRESENTED.slice(7)]) {
        const bad = await mutate(h.app, "POST", "/api/servers/srv_r/machine-identity", h.cookie, { hostKeyFingerprint: typed });
        expect(bad.status).toBe(400);
        expect(((await bad.json()) as ApiError).message).toContain("not a host-key fingerprint");
      }
      // And the statement that would move NEITHER number: the pinned key on a row carrying no
      // recorded machine-id. Nothing this manager holds is in the way, so it reports no repair.
      h.db.sqlite.prepare("UPDATE servers SET machine_id = NULL WHERE id = 'srv_r'").run();
      const same = await mutate(h.app, "POST", "/api/servers/srv_r/machine-identity", h.cookie, { hostKeyFingerprint: PINNED });
      expect(same.status).toBe(400);
      expect(((await same.json()) as ApiError).message).toContain("already what this manager has pinned");

      expect(identityOf(h.db)).toEqual({ hostKey: PINNED, checkedAt: 42, machineId: null });
      expect(identityAt(h.db, "srv_m")).toEqual({ hostKey: PINNED, machineId: MACHINE_ID });
      expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'server.machine_identity_restated'").get()).toEqual({ n: 0 });
    });

    // THE MACHINE-ID MOVES ON ITS OWN, and this route is the only writer that clears it: attest.ts
    // records one where the column is NULL and never overwrites it, so a machine whose
    // /etc/machine-id was regenerated while its host keys stood — a cloned VM, a removed file — is
    // refused by every run kind that attests it until a person says what happened here.
    it("the pinned fingerprint drops the recorded machine-id and moves no pin", async () => {
      const h = await make();
      seedReached(h.db);
      const res = await mutate(h.app, "POST", "/api/servers/srv_r/machine-identity", h.cookie, { hostKeyFingerprint: PINNED });
      expect(res.status).toBe(200);
      expect(identityOf(h.db)).toEqual({ hostKey: PINNED, checkedAt: 42, machineId: null });
      // Audited as the statement it is, with both halves readable: the pin did not move, the id did.
      const row = h.db.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'server.machine_identity_restated'").get() as { detail_json: string };
      expect(JSON.parse(row.detail_json)).toMatchObject({ hostKeyWas: PINNED, hostKeyNow: PINNED, machineIdDropped: MACHINE_ID });
    });

    it("this manager's OWN machine gets that half, which is its only route back", async () => {
      // Its host key is pinned from a deployment configuration re-read on every boot, so the other
      // half stays refused for it — but nothing configures a machine-id, and no other writer clears
      // one, so a re-imaged control host is repaired here or nowhere.
      const h = await make();
      seedThree(h.db);
      pinMachine(h.db, "srv_m");
      const res = await mutate(h.app, "POST", "/api/servers/srv_m/machine-identity", h.cookie, { hostKeyFingerprint: PINNED });
      expect(res.status).toBe(200);
      expect(identityAt(h.db, "srv_m")).toEqual({ hostKey: PINNED, machineId: null });
    });

    it("without the same-origin header → CSRF refused, and the pin stands", async () => {
      const h = await make();
      seedReached(h.db);
      const res = await mutate(h.app, "POST", "/api/servers/srv_r/machine-identity", h.cookie, { hostKeyFingerprint: PRESENTED }, false);
      expect(res.status).toBe(403);
      expect(((await res.json()) as ApiError).code).toBe("CSRF_REFUSED");
      expect(identityOf(h.db).hostKey).toBe(PINNED);
    });

    it("the browser is told which key is pinned, and the rest of the preflight document stays here", async () => {
      const h = await make();
      seedReached(h.db);
      const body = await (await h.app.request("/api/servers", authed(h.cookie))).text();
      expect((JSON.parse(body) as { servers: ServerView[] }).servers[0]).toMatchObject({ hostKeyPinned: PINNED });
      expect(body).not.toContain("checkedAt");
      expect(body).not.toContain(MACHINE_ID);
    });
  });

  describe("the operator-key routes", () => {
    it("POST → 201, GET lists the key by fingerprint, DELETE forgets it", async () => {
      const h = await make();
      const res = await mutate(h.app, "POST", "/api/operator-keys", h.cookie, { label: "pat", publicKey: OPERATOR_KEY });
      expect(res.status).toBe(201);
      const { key } = (await res.json()) as { key: OperatorKeyView };
      expect(key).toMatchObject({ label: "pat", type: "ssh-ed25519", onServerIds: [] });
      // The key BODY is not part of the view — nothing in the browser reads one (api-types.ts OperatorKeyView).
      expect(key).not.toHaveProperty("publicKey");

      const listed = (await (await h.app.request("/api/operator-keys", authed(h.cookie))).json()) as { keys: OperatorKeyView[] };
      expect(listed.keys.map((k) => k.fingerprint)).toEqual([key.fingerprint]);

      expect((await mutate(h.app, "DELETE", `/api/operator-keys/${key.id}`, h.cookie)).status).toBe(200);
      expect((((await (await h.app.request("/api/operator-keys", authed(h.cookie))).json()) as { keys: OperatorKeyView[] })).keys).toEqual([]);
    });

    it("DELETE refuses while a host's last reading still finds the key", async () => {
      const h = await make();
      seedThree(h.db);
      const { key } = (await (
        await mutate(h.app, "POST", "/api/operator-keys", h.cookie, { label: "pat", publicKey: OPERATOR_KEY })
      ).json()) as { key: OperatorKeyView };
      h.db.sqlite
        .prepare("UPDATE servers SET authorized_keys_state = 'accounted', authorized_keys_json = ? WHERE id = 'srv_s'")
        .run(
          JSON.stringify({
            v: 0, observedAt: 1_700_000_000_000, runId: "run_x", unparsed: 0,
            keys: [{ fingerprint: key.fingerprint, type: "ssh-ed25519", comment: "", kind: "operator", label: "pat" }],
          }),
        );
      const res = await mutate(h.app, "DELETE", `/api/operator-keys/${key.id}`, h.cookie);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).message).toContain("s1");
    });
  });
});
