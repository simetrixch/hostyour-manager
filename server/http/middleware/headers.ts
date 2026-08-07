import type { MiddlewareHandler } from "hono";
import type { Config } from "../../kernel/config.ts";

// Fresh security headers. CSP self-only, no framing, nosniff.
export function securityHeaders(_config: Config): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
  };
}
