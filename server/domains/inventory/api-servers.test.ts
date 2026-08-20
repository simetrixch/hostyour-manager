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
import { RunEventBus } from "../../executor/bus.ts";
import { Executor } from "../../executor/executor.ts";
import { buildRegistry } from "../runs/registry.ts";
import { runActor } from "../../kernel/actor.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { registerServerRoutes } from "./api.ts";
import { clusterMarkingPath } from "./cluster-marking.ts";
import { serverCredFlags } from "./write.ts";
import { getRun } from "../../executor/read.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { SshFactory } from "../../adapters/ssh/port.ts";
import type { ApiError, OperatorKeyView, ServerView } from "../../../shared/api-types.ts";

// registerServerRoutes (api.ts:79) — the seven routes the server inventory screen is made of, driven
// through the real app so the chokepoint and the CSRF guard are in the path. The neighbouring
// registerClustersRoutes is covered in api.test.ts and shares the ServerView projection; what is
// exercised HERE is the half that projection never sees: the credential flags GET /api/servers folds
// in (api.ts:83, serverCredFlags), the writes, and the adopt trigger that plans and approves a run.

const config = parseConfig({
  PUBLIC_URL: "https://m1.example",
  OIDC_ISSUER: "https://i.example/",
  OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s",
  CONTROLLER_VERSION: "test",
  DATA_DIR: "/d",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);

// No machine exists for these cases, so every SSH connection is refused. The routes under test START
// runs; carrying one out is the executor's business and is covered in runs/adopt.test.ts. An approved
// adopt therefore fails on its first remote step (defs/adopt.ts:145), which is what settle() waits for.
const noSsh: SshFactory = () => Promise.reject(new Error("no ssh in this harness"));

const PINNED = "1.2.0-stable-20260728120000";
const MASTER = "m1.example.com";
const SLAVE = "s1.example.com";

const OPERATOR_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorPatKeyAAAAAAAAAAAAAAAAAAAAAAAAAA pat@example.com";

interface Harness {
  app: Hono<AppEnv>;
  db: DbHandle;
  store: CredentialStore;
  executor: Executor;
  cookie: string;
}

describe("server inventory API", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];

  async function make(platformRepo?: FakePlatformRepo): Promise<Harness> {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-servers-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    // The chokepoint attributes every write to the session's sub, and runs.started_by is an FK onto
    // operators — in production upsertOperator wrote that row at login; the harness mints the cookie
    // directly, so it seeds the row itself.
    db.sqlite.prepare("INSERT INTO operators (id, username, display_name) VALUES ('op_test', 'test', 'Test')").run();
    const store = new CredentialStore({ db: db.db, logger });
    const executor = new Executor({
      db: db.db,
      creds: store,
      bus: new RunEventBus(),
      logger,
      registry: buildRegistry({ db: db.db }),
      sshFactory: noSsh,
      actor: runActor,
    });
    const session = new SessionCodec(db.db, config);
    const app = createApp({
      config,
      logger,
      getReadiness: () => ({ ok: true, checks: [] }),
      session,
      registerAuth: () => undefined,
      registerProtected: (a) =>
        registerServerRoutes(a, { db: db.db, creds: store, executor, actor: runActor, ...(platformRepo ? { platformRepo } : {}) }),
    });
    const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
    return { app, db, store, executor, cookie };
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

  /** One cluster map as the platform repo carries it (clusters/active/<fqdn>.yaml). `release` is
   *  absent on a cluster no release run has pinned yet. */
  const map = (fqdn: string, role: string, release?: string): string =>
    `fqdn: ${fqdn}\nstage: prod\nrole: ${role}\nbuild-plane: ${MASTER}\n${release ? `release: ${release}\n` : ""}`;

  /** The master pinned, the slave never released — the two states standing side by side. */
  function bothMaps(): FakePlatformRepo {
    const repo = new FakePlatformRepo({ booksBranch: MASTER });
    repo.seed(MASTER, clusterMarkingPath(MASTER), map(MASTER, "master", PINNED));
    repo.seed(MASTER, clusterMarkingPath(SLAVE), map(SLAVE, "slave"));
    return repo;
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
      // buildClustersView (api.ts:59) filters the master out of ClustersView.servers because the
      // controller does not manage itself. This route is the inventory and lists every row, so the
      // master is here — sorted first (read.ts:85).
      const h = await make();
      seedThree(h.db);
      const servers = await listServersOverHttp(h);
      expect(servers.map((s) => s.id)).toEqual(["srv_m", "srv_b", "srv_s"]);
      expect(servers[0]?.role).toBe("master");
    });

    it("reads the release off each server's cluster map, and never borrows one for a server that has none", async () => {
      const h = await make(bothMaps());
      seedThree(h.db);
      const byId = new Map((await listServersOverHttp(h)).map((s) => [s.id, s]));

      expect(byId.get("srv_m")?.release).toEqual({ kind: "pinned", tag: PINNED });
      // The slave's map stands in the same directory as the master's and carries no release key.
      // Anything but "unknown" here is a version somebody guessed.
      expect(byId.get("srv_s")?.release.kind).toBe("unknown");
      expect(byId.get("srv_s")?.release).not.toHaveProperty("tag");
      // b1 is no cluster at all — a state a surface paints differently from an unreadable release.
      expect(byId.get("srv_b")?.release).toEqual({ kind: "no-cluster" });
      expect(JSON.stringify([byId.get("srv_s"), byId.get("srv_b")])).not.toContain(PINNED);
    });

    it("with no platform repo wired, every clustered server says WHY its release is unknown", async () => {
      const h = await make();
      seedThree(h.db);
      for (const id of ["srv_m", "srv_s"]) {
        const release = (await listServersOverHttp(h)).find((s) => s.id === id)?.release;
        expect(release).toEqual({ kind: "unknown", reason: expect.stringContaining("there is no platform repo to read") });
      }
    });

    it("folds in the credential flags — a stored bootstrap password shows, and its value never crosses", async () => {
      const h = await make();
      const created = await mutate(h.app, "POST", "/api/servers", h.cookie, {
        name: "s5", host: "10.1.1.11", sshUser: "hostyour1", password: "shared-secret-xyz",
      });
      expect(created.status).toBe(201);
      await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s6", host: "10.1.1.12", sshUser: "hostyour1" });

      const res = await h.app.request("/api/servers", authed(h.cookie));
      const body = await res.text();
      const servers = (JSON.parse(body) as { servers: ServerView[] }).servers;
      expect(servers.find((s) => s.name === "s5")).toMatchObject({ hasPassword: true, hasKey: false });
      // The counter-probe on the flag: the machine registered WITHOUT a password must not inherit
      // the neighbouring one's flag.
      expect(servers.find((s) => s.name === "s6")).toMatchObject({ hasPassword: false, hasKey: false });
      expect(body).not.toContain("shared-secret-xyz");
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
      // A machine is registered before it is ever a cluster (write.ts:119).
      expect(server.release).toEqual({ kind: "no-cluster" });
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
      // That field carries no max (web/src/pages/Servers.tsx:223) and Servers.tsx:99 passes
      // Number(form.sshPort) straight through, so 70000 reaches CreateServerInput's .max(65535)
      // (write.ts:37). CreateServerInput.parse (api.ts:87) throws a ZodError, and error-shape.ts:13
      // redacts every non-AppError to INTERNAL, so which field was wrong never reaches the browser.
      // The "Slave_5!" body below is not browser-reachable: web/src/pages/Servers.tsx:207 and
      // web/src/pages/AdoptWizard.tsx:62 both carry pattern="[a-z0-9][a-z0-9-]*" required inside a
      // form with no noValidate, so that name is stopped before submit. Asserted as it stands
      // rather than as it should be — this case is the record that the hole is real.
      const h = await make();
      for (const body of [{ name: "Slave_5!", host: "h", sshUser: "root" }, { name: "s5", host: "h", sshUser: "root", sshPort: 70000 }, {}]) {
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
        await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "10.1.1.11", sshUser: "hostyour1", password: "pw" })
      ).json()) as { server: ServerView };
      expect(await serverCredFlags(h.store)).toEqual(new Map([[server.id, { hasPassword: true, hasKey: false }]]));

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

  describe("the operator-key routes", () => {
    it("POST → 201, GET lists the key by fingerprint, DELETE forgets it", async () => {
      const h = await make();
      const res = await mutate(h.app, "POST", "/api/operator-keys", h.cookie, { label: "pat", publicKey: OPERATOR_KEY });
      expect(res.status).toBe(201);
      const { key } = (await res.json()) as { key: OperatorKeyView };
      expect(key).toMatchObject({ label: "pat", type: "ssh-ed25519", onServerIds: [] });
      // The key BODY is not part of the view — nothing in the browser reads one (api-types.ts:171).
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

  describe("POST /api/servers/:id/adopt", () => {
    it("an unknown server is a 404 before any run is planned", async () => {
      const h = await make();
      const res = await mutate(h.app, "POST", "/api/servers/srv_nope/adopt", h.cookie);
      expect(res.status).toBe(404);
      expect(((await res.json()) as ApiError).code).toBe("NOT_FOUND");
      expect(h.db.sqlite.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
    });

    it("with the bootstrap password stored → 202 approved, and the run leaves `planned`", async () => {
      const h = await make();
      const { server } = (await (
        await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "10.1.1.11", sshUser: "hostyour1", password: "shared-secret-xyz" })
      ).json()) as { server: ServerView };

      const res = await mutate(h.app, "POST", `/api/servers/${server.id}/adopt`, h.cookie);
      expect(res.status).toBe(202);
      const { runId, approved } = (await res.json()) as { runId: string; approved: boolean };
      expect(approved).toBe(true);
      expect(runId).toMatch(/^run_/);

      // The approval really fired the run: this harness refuses every SSH connection, so it stops at
      // connect-password. A run still `planned` would mean the route had only planned it.
      await h.executor.settle(runId);
      expect(getRun(h.db.db, runId)?.status).toBe("failed");
      expect(getRun(h.db.db, runId)?.kind).toBe("adopt");
      // onTerminal put the machine back (defs/adopt.ts:462).
      expect((await listServersOverHttp(h)).find((s) => s.id === server.id)?.status).toBe("bare");
    });

    it("with no stored password → 202 NOT approved, and the plan waits for the Run screen's ceremony", async () => {
      const h = await make();
      const { server } = (await (
        await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" })
      ).json()) as { server: ServerView };

      const res = await mutate(h.app, "POST", `/api/servers/${server.id}/adopt`, h.cookie);
      expect(res.status).toBe(202);
      const { runId, approved } = (await res.json()) as { runId: string; approved: boolean };
      expect(approved).toBe(false);
      const run = getRun(h.db.db, runId);
      expect(run?.status).toBe("planned");
      // What the Run screen renders one input for.
      expect(run?.requiredSecrets).toEqual(["adopt-password"]);
      expect(h.db.sqlite.prepare("SELECT started_by AS a FROM runs WHERE id = ?").get(runId)).toEqual({ a: "op_test" });
    });

    it("a password in the body approves a run for a server that has none stored", async () => {
      const h = await make();
      const { server } = (await (
        await mutate(h.app, "POST", "/api/servers", h.cookie, { name: "s5", host: "10.1.1.11", sshUser: "hostyour1" })
      ).json()) as { server: ServerView };

      const res = await mutate(h.app, "POST", `/api/servers/${server.id}/adopt`, h.cookie, { password: "typed-at-the-screen", intendedDomain: SLAVE });
      expect(res.status).toBe(202);
      const { runId, approved } = (await res.json()) as { runId: string; approved: boolean };
      expect(approved).toBe(true);
      await h.executor.settle(runId);
      expect(getRun(h.db.db, runId)?.status).toBe("failed"); // it RAN — a still-planned run was never approved
      // The intended domain rides into the frozen params. Nothing consumes it: AdoptParams declares
      // it at defs/adopt.ts:45 and the only reader is defs/adopt.ts:438, where its ABSENCE pushes
      // the plan warning "DNS wildcard check will be skipped — no domain chosen yet." Passing it
      // therefore suppresses that warning and nothing else — the preflight step (defs/adopt.ts:165)
      // runs PREFLIGHT_SCRIPT and touches neither DNS nor intendedDomain.
      expect(h.db.sqlite.prepare("SELECT params_json AS p FROM runs WHERE id = ?").get(runId)).toEqual({
        p: JSON.stringify({ serverId: server.id, intendedDomain: SLAVE }),
      });
    });
  });
});
