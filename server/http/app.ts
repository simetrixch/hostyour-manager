import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Config } from "../kernel/config.ts";
import type { Logger } from "../kernel/logger.ts";
import type { ApiError, ReadyzView } from "../../shared/api-types.ts";
import type { SessionCodec } from "../domains/access/session.ts";
import type { AppEnv } from "./app-env.ts";
import { securityHeaders } from "./middleware/headers.ts";
import { chokepoint } from "./middleware/chokepoint.ts";
import { FORBIDDEN_CSS, FORBIDDEN_CSS_PATH } from "../domains/access/forbidden.ts";
import { csrfGuard } from "./middleware/csrf.ts";
import { toApiError } from "./middleware/error-shape.ts";

export interface AppDeps {
  config: Config;
  logger: Logger;
  getReadiness: () => ReadyzView;
  session: SessionCodec;
  registerAuth: (app: Hono<AppEnv>) => void;
  registerProtected?: (app: Hono<AppEnv>) => void;
}

// App assembly: headers → public /healthz,/readyz,403-stylesheet,/auth → chokepoint →
// protected routes (H) → static SPA (I). The order is law: the chokepoint sits between the
// public routes and everything else, so nothing protected can be reached ungated.
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", securityHeaders(deps.config));

  app.get("/healthz", (c) => c.json({ status: "ok" as const, version: deps.config.version }));
  app.get("/readyz", (c) => {
    const r = deps.getReadiness();
    return c.json(r, r.ok ? 200 : 503);
  });
  // The 403 document's stylesheet. Public on purpose: the CSP forbids inline
  // style, and behind the gate the chokepoint would answer a forbidden operator's stylesheet
  // fetch with JSON 403 (it is not a document request), leaving the page bare.
  app.get(FORBIDDEN_CSS_PATH, (c) => c.body(FORBIDDEN_CSS, 200, { "content-type": "text/css" }));

  deps.registerAuth(app); // PUBLIC /auth/* — must precede the chokepoint
  app.use("*", chokepoint(deps.config, deps.session)); // gate everything below
  app.use("*", csrfGuard(deps.config)); // same-origin on unsafe methods, past the gate
  deps.registerProtected?.(app);

  app.notFound((c) => c.json({ code: "NOT_FOUND", message: "Not found" } satisfies ApiError, 404));
  app.onError((err, c) => {
    const { status, body } = toApiError(err);
    deps.logger.error({ err }, "request error");
    return c.json(body, status as ContentfulStatusCode);
  });

  return app;
}
