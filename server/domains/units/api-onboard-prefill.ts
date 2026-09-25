import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";
import type { OnboardPrefillView } from "../../../shared/api-types-onboard.ts";
import { OnboardPrefillRequest, readOnboardPrefill } from "./onboard-prefill.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import type { Db } from "../../db/client.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { ReleaseVersionDeps } from "#unit/server/release-version.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";

// The wizard's PREFILL route, apart from api.ts the way api-unit-sizes.ts is: the version the
// onboarding will release, read off the repository's release tags before any run exists
// (onboard-prefill.ts). The PAT rides the one tag listing and is not kept.
export interface OnboardPrefillApiDeps extends Partial<ReleaseVersionDeps> {
  onboardingEnabled: boolean;
  db: Db;
  store: Pick<CredentialStore, "open" | "list">;
  /** The platform's GitHub App — the identity of a repository its installation reaches. */
  githubApp?: GitHubApp;
}

export function registerOnboardPrefillRoute(app: Hono<AppEnv>, deps: OnboardPrefillApiDeps): void {
  const { onboardingEnabled, github, platformGitHub, platformRepo, githubApp, db, store } = deps;
  app.post("/api/consumers/prefill", async (c) => {
    if (!onboardingEnabled || !github) throw errNotConfigured("onboarding is not configured on this manager — the gate-runner and git/kube/vault adapters must be wired first");
    const parsed = OnboardPrefillRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation(`invalid onboard prefill request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const view = await readOnboardPrefill({ github, ...(platformGitHub ? { platformGitHub } : {}), ...(platformRepo ? { platformRepo } : {}), ...(githubApp ? { githubApp } : {}), owners: (org) => readOwnerIdentity(db, org), store }, parsed.data, c.req.raw.signal);
    return c.json(view satisfies OnboardPrefillView);
  });
}
