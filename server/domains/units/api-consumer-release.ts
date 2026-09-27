import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../http/app-env.ts";
import type { Executor } from "../../executor/executor.ts";
import type { Db } from "../../db/client.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";
import { readConsumerVersions, type SetReleasePorts } from "./set-release.run.ts";
import type { ChannelStages } from "../inventory/channel-stages.ts";

// The routes that put a release of a STANDING app on its stage again (#299), apart from api.ts the
// way the secrets routes are. The GET answers what the Versions dialog offers — the releases, the one
// that runs, and which are older — read as the plan reads them. The POST plans through the STREAMING
// planner, because the repository is read while the run sits in `planning`.
export function registerConsumerReleaseRoute(
  app: Hono<AppEnv>,
  deps: { executor: Executor; onboardingEnabled: boolean; db: Db; channelStages?: () => Promise<ChannelStages> } & Partial<Pick<SetReleasePorts, "github" | "store" | "githubApp">>,
): void {
  app.get("/api/consumers/:appId/versions", async (c) => {
    if (!deps.onboardingEnabled || !deps.github || !deps.store || !deps.channelStages) throw errNotConfigured("onboarding is not configured on this manager");
    const ports = { github: deps.github, store: deps.store, channelStages: deps.channelStages, ...(deps.githubApp ? { githubApp: deps.githubApp } : {}) };
    return c.json(await readConsumerVersions(ports, deps.db, c.req.param("appId"), c.req.raw.signal));
  });
  app.post("/api/consumers/:appId/release", async (c) => {
    if (!deps.onboardingEnabled) throw errNotConfigured("onboarding is not configured on this manager");
    const body = z.object({ tag: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw errValidation(`invalid release request: ${body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await deps.executor.planStreamed("consumer-set-release", { appId: c.req.param("appId"), tag: body.data.tag }), 201);
  });
}
