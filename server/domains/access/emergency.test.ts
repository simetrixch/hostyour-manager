import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { SessionCodec, SESSION_COOKIE } from "./session.ts";
import { EmergencyStore, createEmergencyApp, createAdminSocketApp, serveAdminSocket } from "./emergency.ts";

const baseEnv = {
  PUBLIC_URL: "https://m1.example",
  OIDC_ISSUER: "https://idp.example/",
  OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test",
  DATA_DIR: "/d",
  ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
  LOG_LEVEL: "silent",
};
const config = parseConfig(baseEnv as NodeJS.ProcessEnv);
const logger = createLogger(config);

function setCookieValue(res: Response, name: string): string | undefined {
  const hit = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).split(";")[0] : undefined;
}

describe("break-glass", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): { db: DbHandle; session: SessionCodec; store: EmergencyStore } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-bg-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    return { db, session: new SessionCodec(db.db, config), store: new EmergencyStore() };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a token is single-use: redeem succeeds once, then fails", () => {
    const store = new EmergencyStore();
    const token = store.mint();
    expect(store.redeem(token)).toBe(true);
    expect(store.redeem(token)).toBe(false);
  });

  it("an unknown token is refused", () => {
    const store = new EmergencyStore();
    store.mint();
    expect(store.redeem("not-a-real-token")).toBe(false);
  });

  it("GET /auth/emergency with a valid token → 302 + emergency session cookie", async () => {
    const { db, session, store } = fresh();
    const app = createEmergencyApp({ config, session, store, db: db.db, logger });
    const token = store.mint();
    const res = await app.request(`/auth/emergency?token=${token}`);
    expect(res.status).toBe(302);
    const cookie = setCookieValue(res, SESSION_COOKIE);
    expect(cookie).toBeTruthy();
    const verdict = await session.verify(cookie ?? "");
    expect(verdict.kind).toBe("ok");
    if (verdict.kind === "ok") {
      expect(verdict.session.via).toBe("emergency");
      expect(verdict.session.sub).toBe("op_emergency");
      expect(verdict.session.groups).toContain(config.oidc.adminsGroup);
    }
  });

  it("GET /auth/emergency with a wrong/used token → 401", async () => {
    const { db, session, store } = fresh();
    const app = createEmergencyApp({ config, session, store, db: db.db, logger });
    expect((await app.request("/auth/emergency?token=nope")).status).toBe(401);
    const token = store.mint();
    await app.request(`/auth/emergency?token=${token}`); // consume it
    expect((await app.request(`/auth/emergency?token=${token}`)).status).toBe(401); // reused → 401
  });

  // AF_UNIX socket files and their modes are Linux semantics (Windows refuses the bind), so this
  // runs where the check battery runs on Linux — the mode is THE boundary in front of the
  // unauthenticated token mint: connecting to a UNIX socket needs only write permission on the file.
  //
  // TWO modes, because one proves nothing. A literal left at the chmod call passes any single-mode
  // assertion that happens to name the same number, so the second mode is what says the value was
  // READ from the config and not written into the code.
  it.skipIf(process.platform === "win32")("admin.sock carries the mode ADMIN_SOCKET_MODE names — set explicitly, never umask-inherited", async () => {
    for (const [written, expected] of [["0770", 0o770], ["0700", 0o700]] as const) {
      const { db, session, store } = fresh();
      const dir = mkdtempSync(join(tmpdir(), "mgr-sock-"));
      dirs.push(dir);
      const sockPath = join(dir, "admin.sock");
      const modeConfig = parseConfig({ ...baseEnv, ADMIN_SOCKET_MODE: written } as NodeJS.ProcessEnv);
      const server = serveAdminSocket(sockPath, { config: modeConfig, session, store, db: db.db, logger });
      try {
        await new Promise<void>((resolve, reject) => {
          server.on("listening", () => resolve());
          server.on("error", (err) => reject(err));
        });
        expect(statSync(sockPath).mode & 0o777, `ADMIN_SOCKET_MODE=${written}`).toBe(expected);
      } finally {
        server.close();
      }
    }
  });

  it("the emergency session passes the main app chokepoint (recovers real access)", async () => {
    const { db, session, store } = fresh();
    const emergencyApp = createEmergencyApp({ config, session, store, db: db.db, logger });
    const mainApp = createApp({
      config,
      logger,
      getReadiness: () => ({ ok: true, checks: [] }),
      session,
      registerAuth: () => undefined,
      registerProtected: (a) => a.get("/protected", (c) => c.json({ ok: true, via: c.get("operator").via })),
    });
    const token = store.mint();
    const redeem = await emergencyApp.request(`/auth/emergency?token=${token}`);
    const cookie = setCookieValue(redeem, SESSION_COOKIE) ?? "";
    const prot = await mainApp.request("/protected", { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(prot.status).toBe(200);
    expect(await prot.json()).toMatchObject({ ok: true, via: "emergency" });
  });
});

describe("admin.sock app", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): { db: DbHandle; session: SessionCodec; store: EmergencyStore } {
    const dir = mkdtempSync(join(tmpdir(), "mgr-sockapp-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    return { db, session: new SessionCodec(db.db, config), store: new EmergencyStore() };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("POST /auth/session hands out a session that passes the main app's chokepoint as a bearer", async () => {
    const { db, session, store } = fresh();
    const sockApp = createAdminSocketApp({ config, session, store, db: db.db, logger });
    const mainApp = createApp({
      config,
      logger,
      getReadiness: () => ({ ok: true, checks: [] }),
      session,
      registerAuth: () => undefined,
      registerProtected: (a) => a.get("/protected", (c) => c.json({ sub: c.get("operator").sub, via: c.get("operator").via })),
    });

    const minted = await sockApp.request("/auth/session", { method: "POST" });
    expect(minted.status).toBe(200);
    const { session: bearer } = (await minted.json()) as { session: string };
    expect(bearer).toBeTruthy();

    const prot = await mainApp.request("/protected", { headers: { authorization: `Bearer ${bearer}` } });
    expect(prot.status).toBe(200);
    expect(await prot.json()).toMatchObject({ sub: "op_emergency", via: "emergency" });
  });

  // ONE action and ONE row shape for both ways in, with the door as a value inside it: a reader
  // who asks `WHERE action = 'operator.login'` still sees every mint there has ever been, and can
  // then say which of the two each one was — without the log line.
  it("both ways in write one audit action and one row shape, differing only in arrivedBy", async () => {
    const { db, session, store } = fresh();
    const sockApp = createAdminSocketApp({ config, session, store, db: db.db, logger });
    const emergencyApp = createEmergencyApp({ config, session, store, db: db.db, logger });

    await sockApp.request("/auth/session", { method: "POST" });
    await emergencyApp.request(`/auth/emergency?token=${store.mint()}`);

    const rows = db.sqlite.prepare("SELECT actor, action, detail_json FROM audit WHERE action = 'operator.login' ORDER BY id").all() as {
      actor: string;
      action: string;
      detail_json: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.actor)).toEqual(["op_emergency", "op_emergency"]);
    const details = rows.map((r) => JSON.parse(r.detail_json ?? "null") as Record<string, unknown>);
    expect(details.map((d) => Object.keys(d).sort())).toEqual([
      ["arrivedBy", "method"],
      ["arrivedBy", "method"],
    ]);
    expect(details[0]).toEqual({ method: "emergency", arrivedBy: "admin_sock" });
    expect(details[1]).toEqual({ method: "emergency", arrivedBy: "browser_redeem" });
  });

  // The sealed session is the SAME on both sides of that distinction: the door is recorded, the
  // authority the session rests on is not re-labelled — so reset/api.ts keeps refusing both.
  it("neither door changes the session: both are via 'emergency' on op_emergency", async () => {
    const { db, session, store } = fresh();
    const sockApp = createAdminSocketApp({ config, session, store, db: db.db, logger });
    const emergencyApp = createEmergencyApp({ config, session, store, db: db.db, logger });

    const { session: bearer } = (await (await sockApp.request("/auth/session", { method: "POST" })).json()) as { session: string };
    const redeem = await emergencyApp.request(`/auth/emergency?token=${store.mint()}`);
    const cookie = setCookieValue(redeem, SESSION_COOKIE) ?? "";

    for (const sealed of [bearer, cookie]) {
      const verdict = await session.verify(sealed);
      expect(verdict.kind).toBe("ok");
      if (verdict.kind === "ok") {
        expect(verdict.session.via).toBe("emergency");
        expect(verdict.session.sub).toBe("op_emergency");
      }
    }
  });

  it("POST /auth/break-glass still hands out a redeem URL, and the token in it redeems once", async () => {
    const { db, session, store } = fresh();
    const sockApp = createAdminSocketApp({ config, session, store, db: db.db, logger });
    const emergencyApp = createEmergencyApp({ config, session, store, db: db.db, logger });

    const res = await sockApp.request("/auth/break-glass", { method: "POST" });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toContain(`http://127.0.0.1:${config.emergencyPort}/auth/emergency?token=`);

    const path = url.slice(`http://127.0.0.1:${config.emergencyPort}`.length);
    expect((await emergencyApp.request(path)).status).toBe(302);
    expect((await emergencyApp.request(path)).status).toBe(401); // single-use
  });

  it("an unknown route on the socket is a 404, not a session", async () => {
    const { db, session, store } = fresh();
    const sockApp = createAdminSocketApp({ config, session, store, db: db.db, logger });
    expect((await sockApp.request("/auth/session")).status).toBe(404); // GET — the route is POST
    expect((await sockApp.request("/", { method: "POST" })).status).toBe(404);
  });

  // The listener really speaks HTTP over AF_UNIX — the app tests above prove the routes, this one
  // proves the transport carrying them, which is the whole change to serveAdminSocket. AF_UNIX is
  // Linux semantics (Windows refuses the bind), so it runs where the check battery runs on Linux.
  it.skipIf(process.platform === "win32")("serveAdminSocket answers a real HTTP request over the unix socket", async () => {
    const { db, session, store } = fresh();
    const dir = mkdtempSync(join(tmpdir(), "mgr-sock-"));
    dirs.push(dir);
    const socketPath = join(dir, "admin.sock");
    const server = serveAdminSocket(socketPath, { config, session, store, db: db.db, logger });
    try {
      await new Promise<void>((resolve, reject) => {
        server.on("listening", () => resolve());
        server.on("error", (err) => reject(err));
      });
      const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = httpRequest({ socketPath, path: "/auth/session", method: "POST" }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        });
        req.on("error", reject);
        req.end();
      });
      expect(body.status).toBe(200);
      const { session: bearer } = JSON.parse(body.text) as { session: string };
      expect((await session.verify(bearer)).kind).toBe("ok");
    } finally {
      server.close();
    }
  });
});
