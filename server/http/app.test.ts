import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { parseConfig } from "../kernel/config.ts";
import { createLogger } from "../kernel/logger.ts";
import { openDb, type DbHandle } from "../db/client.ts";
import { SessionCodec, SESSION_COOKIE } from "../domains/access/session.ts";
import { FORBIDDEN_CSS, FORBIDDEN_CSS_PATH } from "../domains/access/forbidden.ts";
import type { ReadyzView } from "../../shared/api-types.ts";

const config = parseConfig({
  PUBLIC_URL: "https://m1.example.com",
  OIDC_ISSUER: "https://idp.example/o/controller/",
  OIDC_CLIENT_ID: "controller",
  OIDC_CLIENT_SECRET: "secret",
  CONTROLLER_VERSION: "test",
  DATA_DIR: "/data",
  LOG_LEVEL: "silent",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);

describe("http app shell + gate", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function make(readiness: ReadyzView): { app: ReturnType<typeof createApp>; session: SessionCodec } {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-app-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    const session = new SessionCodec(db.db, config);
    const app = createApp({ config, logger, getReadiness: () => readiness, session, registerAuth: () => undefined });
    return { app, session };
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("GET /healthz → 200 {status:ok} (public)", async () => {
    const res = await make({ ok: true, checks: [] }).app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: expect.any(String) });
  });

  it("GET /readyz → 200 ready, 503 down (public)", async () => {
    expect((await make({ ok: true, checks: [] }).app.request("/readyz")).status).toBe(200);
    expect((await make({ ok: false, checks: [] }).app.request("/readyz")).status).toBe(503);
  });

  it("sets security headers on every response", async () => {
    const res = await make({ ok: true, checks: [] }).app.request("/healthz");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("an unauthenticated API request is gated 401 (not 404)", async () => {
    const res = await make({ ok: true, checks: [] }).app.request("/api/anything", { headers: { accept: "application/json" } });
    expect(res.status).toBe(401);
  });

  it("the 403 document renders styled under the shipped CSP: no inline style, stylesheet public", async () => {
    const { app, session } = make({ ok: true, checks: [] });

    // A non-member's document GET is answered with the 403 page.
    const token = await session.mint({ sub: "op_x", groups: ["users"], via: "oidc" });
    const res = await app.request("/", { headers: { cookie: `${SESSION_COOKIE}=${token}`, accept: "text/html" } });
    expect(res.status).toBe(403);

    // The refusal this guards against: a CSP without 'unsafe-inline' makes the
    // browser drop any inline style, so the page must not carry one.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    const html = await res.text();
    expect(html).not.toContain("<style");
    expect(html).not.toContain("style=");
    expect(html).toContain(FORBIDDEN_CSS_PATH);

    // The stylesheet the page links resolves WITHOUT a session — a stylesheet
    // fetch is not a document request, so behind the gate it would get JSON 403, not CSS.
    const css = await app.request(FORBIDDEN_CSS_PATH);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css");
    expect(await css.text()).toBe(FORBIDDEN_CSS);
  });

  it("an authenticated member reaching an unknown route → 404 (past the gate)", async () => {
    const { app, session } = make({ ok: true, checks: [] });
    const token = await session.mint({ sub: "op_x", groups: ["admins"], via: "oidc" });
    const res = await app.request("/nope", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("the chokepoint slides the idle window: every authenticated request re-mints the cookie", async () => {
    // Fakes ONLY Date (both lifetime checks read the wall clock) — a real sleep under full-suite
    // CPU contention overshoots any margin. Absolute stays long; the cap is session.test.ts's concern.
    const shortIdle = { ...config, session: { idleSeconds: 30, absoluteSeconds: 43200 } };
    const dir = mkdtempSync(join(tmpdir(), "ctrl-app-"));
    dirs.push(dir);
    const db = openDb(join(dir, "controller.db"));
    handles.push(db);
    const session = new SessionCodec(db.db, shortIdle);
    const app = createApp({ config: shortIdle, logger, getReadiness: () => ({ ok: true, checks: [] }), session, registerAuth: () => undefined });
    const cookieValue = (res: Response): string => {
      const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
      if (!set) throw new Error("expected the response to re-mint the session cookie");
      return set.slice(SESSION_COOKIE.length + 1).split(";")[0] ?? "";
    };
    const get = async (cookie: string): Promise<Response> => app.request("/nope", { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });

    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date"] });
    try {
      const original = await session.mint({ sub: "op_x", groups: ["admins"], via: "oidc" });
      vi.setSystemTime(1_700_000_020_000); // 20s after login — inside the idle window
      const first = await get(original); // activity → re-minted cookie rides Set-Cookie
      expect(first.status).toBe(404);
      const slid = cookieValue(first);
      vi.setSystemTime(1_700_000_040_000); // 40s after login, 20s after the last activity
      // The slid cookie is inside ITS idle window and passes the gate…
      expect((await get(slid)).status).toBe(404);
      // …while the original cookie — last activity at login — is idle-dead and gated out.
      expect((await get(original)).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});
