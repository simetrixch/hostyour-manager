import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import type { Db } from "../../db/client.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";
import { readSecretOffer, type ManifestReadPorts } from "./set-secrets.run.ts";

// The routes that change a declared secret of a STANDING consumer (#245), apart from api.ts the way
// api-tenant-apps-repo.ts is. The GET answers what the Secrets dialog offers, read off the manifest
// as the plan reads it: the keys the operator fills at approve, and the generate keys, each ticked
// or not (#285). The POST plans through the STREAMING planner, like the onboarding and for the same
// reason — which keys exist is the repository manifest's answer, read while the run sits in
// `planning` — with the generate keys the dialog ticked as `mint`, none by default.
export function registerConsumerSecretsRoute(app: Hono<AppEnv>, deps: { executor: Executor; onboardingEnabled: boolean; db: Db } & Partial<ManifestReadPorts>): void {
  app.get("/api/consumers/:appId/secrets", async (c) => {
    if (!deps.onboardingEnabled || !deps.github || !deps.store) throw errNotConfigured("onboarding is not configured on this manager");
    const ports: ManifestReadPorts = { github: deps.github, store: deps.store, ...(deps.githubApp ? { githubApp: deps.githubApp } : {}) };
    return c.json(await readSecretOffer(ports, deps.db, c.req.param("appId"), c.req.raw.signal));
  });
  app.post("/api/consumers/:appId/secrets", async (c) => {
    if (!deps.onboardingEnabled) throw errNotConfigured("onboarding is not configured on this manager");
    const body = z.object({ mint: z.array(z.string()).default([]) }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw errValidation(`invalid secrets request: ${body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await deps.executor.planStreamed("consumer-set-secrets", { appId: c.req.param("appId"), mint: body.data.mint }), 201);
  });
}
