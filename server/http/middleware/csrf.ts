import type { MiddlewareHandler } from "hono";
import type { Config } from "../../kernel/config.ts";
import { csrfOk } from "../../domains/access/csrf.ts";
import { errCsrfRefused } from "../../kernel/errors.ts";
import type { AppEnv } from "../app-env.ts";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Same-origin enforcement for unsafe methods. An HTTP-layer concern, not a
 * domain one — so the Access csrf predicate is applied here as middleware rather than imported
 * by each domain's routes (which would breach domains-no-crosstalk). Runs after the chokepoint,
 * so it guards every protected mutation.
 */
export function csrfGuard(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!UNSAFE.has(c.req.method)) return next();
    // Bearer requests are exempt, and no other shape is. CSRF is an attack on the COOKIE: a
    // browser attaches it to a request the victim's page never intended, so a mutation arriving
    // with neither sec-fetch-site nor origin has to be refused. A bearer is never attached by a
    // browser on somebody's behalf — only the caller holding it sets it — and a page cannot set
    // one cross-origin either, because `Authorization` is not a CORS-safelisted request header:
    // the browser preflights, and this server answers no CORS headers at all. So the two headers
    // the guard looks for are ones a programmatic caller cannot send, and a cookie request that
    // omits them stays refused.
    //
    // Read from the chokepoint's verdict, never from the raw header. `authCarrier` is "bearer"
    // only where the session that got past the gate came out of the Authorization header; a
    // request carrying an invalid one is judged on that value alone and answered 401 upstream, so
    // nothing can buy this exemption for a cookie it fell back to. Absent (a route mounted above
    // the chokepoint) is not "bearer".
    if (c.get("authCarrier") === "bearer") return next();
    if (!csrfOk({ secFetchSite: c.req.header("sec-fetch-site"), origin: c.req.header("origin") }, config)) throw errCsrfRefused();
    return next();
  };
}
