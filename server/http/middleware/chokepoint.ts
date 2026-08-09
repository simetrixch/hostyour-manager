import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Config } from "../../kernel/config.ts";
import { runAsActor } from "../../kernel/actor.ts";
import type { SessionCodec } from "../../domains/access/session.ts";
import { sessionCookieName } from "../../domains/access/session.ts";
import { requireOperator } from "../../domains/access/chokepoint.ts";
import { renderForbidden } from "../../domains/access/forbidden.ts";
import type { ApiError } from "../../../shared/api-types.ts";
import type { AppEnv } from "../app-env.ts";

const wantsHtml = (c: Context): boolean => c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html");

/**
 * THE authentication chokepoint. Runs after the public /auth, /healthz,
 * /readyz and 403-stylesheet routes, in front of everything else. The three gate outcomes get three distinct
 * responses — a valid-but-forbidden session is answered 403 (document) / 403 (API), NEVER a
 * redirect to login. That is the structural reason the old console's redirect loop cannot
 * recur here.
 */
export function chokepoint(config: Config, session: SessionCodec): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const verdict = await session.verify(getCookie(c, sessionCookieName(config)) ?? "");
    const gate = requireOperator(verdict.kind === "ok" ? verdict.session : undefined, config.oidc.adminsGroup);

    if (gate.kind === "ok") {
      c.set("operator", gate.operator);
      // Slide the idle window: re-mint the cookie with iat=now and the absolute anchor unchanged,
      // so SESSION_IDLE_SECONDS measures time since the last request and SESSION_ABSOLUTE_SECONDS
      // still caps the session at its first-login moment (the refreshed exp never moves).
      setCookie(c, sessionCookieName(config), await session.refresh(gate.operator), {
        httpOnly: true, secure: config.cookieSecure, sameSite: "Lax", path: "/",
      });
      // Attribute everything this request does — however deep the async chain — to the signed-in
      // operator: the Executor's and CredentialStore's audit writes read it back via currentActor().
      return runAsActor(gate.operator.sub, () => next());
    }
    if (gate.kind === "unauthenticated") {
      if (wantsHtml(c)) return c.redirect(`/auth/login?next=${encodeURIComponent(c.req.path)}`, 302);
      return c.json({ code: "UNAUTHENTICATED", message: "Not signed in" } satisfies ApiError, 401);
    }
    // forbidden — authenticated, not a member
    if (wantsHtml(c)) {
      return c.html(
        renderForbidden({ group: config.oidc.adminsGroup, signoutUrl: "/auth/logout", ...(gate.identity.email ? { email: gate.identity.email } : {}) }),
        403,
      );
    }
    return c.json({ code: "NOT_A_MEMBER", message: `Not a member of ${config.oidc.adminsGroup}` } satisfies ApiError, 403);
  };
}
