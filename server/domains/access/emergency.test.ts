import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { SessionCodec, SESSION_COOKIE } from "./session.ts";
import { EmergencyStore, createEmergencyApp, serveAdminSocket } from "./emergency.ts";

const config = parseConfig({
  PUBLIC_URL: "https://m1.example",
  OIDC_ISSUER: "https://idp.example/",
  OIDC_CLIENT_ID: "c",
  OIDC_CLIENT_SECRET: "s",
  CONTROLLER_VERSION: "test",
  DATA_DIR: "/d",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);

function setCookieValue(res: Response, name: string): string | undefined {
  const hit = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).split(";")[0] : undefined;
}

describe("break-glass", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): { db: DbHandle; session: SessionCodec; store: EmergencyStore } {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-bg-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
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
  it.skipIf(process.platform === "win32")("admin.sock is created 0700 — set explicitly, never umask-inherited", async () => {
    const { db, session, store } = fresh();
    const dir = mkdtempSync(join(tmpdir(), "ctrl-sock-"));
    dirs.push(dir);
    const sockPath = join(dir, "admin.sock");
    const server = serveAdminSocket(sockPath, { config, session, store, db: db.db, logger });
    try {
      await new Promise<void>((resolve, reject) => {
        server.on("listening", () => resolve());
        server.on("error", (err) => reject(err));
      });
      expect(statSync(sockPath).mode & 0o777).toBe(0o700);
    } finally {
      server.close();
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
