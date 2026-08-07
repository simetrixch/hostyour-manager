import type { MiddlewareHandler } from "hono";
import type { Config } from "../../kernel/config.ts";
import { csrfOk } from "../../domains/access/csrf.ts";
import { errCsrfRefused } from "../../kernel/errors.ts";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Same-origin enforcement for unsafe methods. An HTTP-layer concern, not a
 * domain one — so the Access csrf predicate is applied here as middleware rather than imported
 * by each domain's routes (which would breach domains-no-crosstalk). Runs after the chokepoint,
 * so it guards every protected mutation.
 */
export function csrfGuard(config: Config): MiddlewareHandler {
  return async (c, next) => {
    if (UNSAFE.has(c.req.method) && !csrfOk({ secFetchSite: c.req.header("sec-fetch-site"), origin: c.req.header("origin") }, config)) {
      throw errCsrfRefused();
    }
    return next();
  };
}
