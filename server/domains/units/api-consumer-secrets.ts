import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import { errNotConfigured } from "../../kernel/errors.ts";

// The one route that changes a declared secret of a STANDING consumer (#245), apart from api.ts the
// way api-tenant-apps-repo.ts is: it plans through the STREAMING planner, like the onboarding and
// for the same reason — which keys exist is the repository manifest's answer, read while the run
// sits in `planning`, so a key the manifest gained since the onboarding is offered and one it
// dropped is not. No body: every declared key is offered OPTIONAL at approve, and what the operator
// fills is what changes.
export function registerConsumerSecretsRoute(app: Hono<AppEnv>, deps: { executor: Executor; onboardingEnabled: boolean }): void {
  app.post("/api/consumers/:appId/secrets", async (c) => {
    if (!deps.onboardingEnabled) throw errNotConfigured("onboarding is not configured on this manager");
    return c.json(await deps.executor.planStreamed("consumer-set-secrets", { appId: c.req.param("appId") }), 201);
  });
}
