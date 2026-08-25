import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { SessionCodec, SESSION_COOKIE } from "../../domains/access/session.ts";
import type { ApiError } from "../../../shared/api-types.ts";

const config = parseConfig({
  PUBLIC_URL: "https://m1.example.com",
  OIDC_ISSUER: "https://idp.example/o/manager/",
  OIDC_CLIENT_ID: "manager",
  OIDC_CLIENT_SECRET: "secret",
  MANAGER_VERSION: "test",
  DATA_DIR: "/data",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);

/**
 * The two carriers of ONE session, at the two middlewares that tell them apart: the chokepoint
 * (which accepts either) and the CSRF guard (which exempts only the bearer). The app is built
 * whole rather than the middlewares called in isolation, because the exemption depends on the
 * ORDER app.ts fixes — the guard reads a carrier the chokepoint must already have decided.
 */
describe("session carriers: cookie and bearer", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function make(): { app: ReturnType<typeof createApp>; session: SessionCodec } {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-carrier-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    const session = new SessionCodec(db.db, config);
    const app = createApp({
      config,
      logger,
      getReadiness: () => ({ ok: true, checks: [] }),
      session,
      registerAuth: () => undefined,
      registerProtected: (a) => {
        a.get("/api/who", (c) => c.json({ sub: c.get("operator").sub, carrier: c.get("authCarrier") }));
        a.post("/api/mutate", (c) => c.json({ sub: c.get("operator").sub, carrier: c.get("authCarrier") }));
      },
    });
    return { app, session };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const admin = (session: SessionCodec): Promise<string> => session.mint({ sub: "op_x", groups: ["admins"], via: "oidc" });

  it("the same sealed value passes the gate as a cookie and as a bearer", async () => {
    const { app, session } = make();
    const sealed = await admin(session);

    const viaCookie = await app.request("/api/who", { headers: { cookie: `${SESSION_COOKIE}=${sealed}` } });
    expect(viaCookie.status).toBe(200);
    expect(await viaCookie.json()).toEqual({ sub: "op_x", carrier: "cookie" });

    const viaBearer = await app.request("/api/who", { headers: { authorization: `Bearer ${sealed}` } });
    expect(viaBearer.status).toBe(200);
    expect(await viaBearer.json()).toEqual({ sub: "op_x", carrier: "bearer" });
  });

  it("a bearer earns only what its claims carry: a non-member is 403, not 200 and not 401", async () => {
    const { app, session } = make();
    const outsider = await session.mint({ sub: "op_y", groups: ["users"], via: "oidc" });
    const res = await app.request("/api/who", { headers: { authorization: `Bearer ${outsider}`, accept: "application/json" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiError).code).toBe("NOT_A_MEMBER");
  });

  it("an unparsable bearer is 401, and a bearer never falls back to a cookie that is present", async () => {
    const { app, session } = make();
    const sealed = await admin(session);
    const res = await app.request("/api/who", {
      headers: { authorization: "Bearer not-a-session", cookie: `${SESSION_COOKIE}=${sealed}`, accept: "application/json" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiError).code).toBe("UNAUTHENTICATED");
  });

  it("an Authorization header of another scheme is ignored, and the cookie still carries the session", async () => {
    const { app, session } = make();
    const sealed = await admin(session);
    const res = await app.request("/api/who", { headers: { authorization: "Basic bm9wZQ==", cookie: `${SESSION_COOKIE}=${sealed}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "op_x", carrier: "cookie" });
  });

  it("a bearer request gets no Set-Cookie — the caller is never handed a credential it did not present", async () => {
    const { app, session } = make();
    const sealed = await admin(session);
    const res = await app.request("/api/who", { headers: { authorization: `Bearer ${sealed}` } });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    // …while the cookie carrier still slides its idle window on every request.
    const cookied = await app.request("/api/who", { headers: { cookie: `${SESSION_COOKIE}=${sealed}` } });
    expect(cookied.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
  });

  it("a bearer POST with neither sec-fetch-site nor origin passes the CSRF guard", async () => {
    const { app, session } = make();
    const sealed = await admin(session);
    const res = await app.request("/api/mutate", { method: "POST", headers: { authorization: `Bearer ${sealed}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "op_x", carrier: "bearer" });
  });

  it("the SAME POST on the cookie carrier is still refused — the exemption is the bearer's alone", async () => {
    const { app, session } = make();
    const sealed = await admin(session);
    const res = await app.request("/api/mutate", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${sealed}`, accept: "application/json" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiError).code).toBe("CSRF_REFUSED");
  });

  it("a cross-site cookie POST stays refused however the Authorization header is dressed up", async () => {
    const { app, session } = make();
    const sealed = await admin(session);
    // A bogus bearer alongside the victim's cookie: the chokepoint judges the bearer alone, so the
    // request never reaches the guard as an authenticated cookie request wearing an exemption.
    const forged = await app.request("/api/mutate", {
      method: "POST",
      headers: { authorization: "Bearer forged", cookie: `${SESSION_COOKIE}=${sealed}`, origin: "https://evil.example", accept: "application/json" },
    });
    expect(forged.status).toBe(401);
    // And with no Authorization at all it is the plain CSRF refusal.
    const plain = await app.request("/api/mutate", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${sealed}`, origin: "https://evil.example", accept: "application/json" },
    });
    expect(plain.status).toBe(403);
    expect(((await plain.json()) as ApiError).code).toBe("CSRF_REFUSED");
  });

  it("an Authorization header that is not a bearer buys no exemption — the cookie POST is still refused", async () => {
    const { app, session } = make();
    const sealed = await admin(session);
    // The request authenticates by COOKIE (the scheme is not Bearer, so the chokepoint reads the
    // cookie), and carries neither sec-fetch-site nor origin. A guard that keyed the exemption on
    // the presence of an Authorization header instead of on the carrier would let this through.
    const res = await app.request("/api/mutate", {
      method: "POST",
      headers: { authorization: "Basic bm9wZQ==", cookie: `${SESSION_COOKIE}=${sealed}`, accept: "application/json" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiError).code).toBe("CSRF_REFUSED");
  });

  it("neither carrier opens anything: no session at all is still 401 on read and on write", async () => {
    const { app } = make();
    expect((await app.request("/api/who", { headers: { accept: "application/json" } })).status).toBe(401);
    expect((await app.request("/api/mutate", { method: "POST", headers: { accept: "application/json" } })).status).toBe(401);
  });
});
