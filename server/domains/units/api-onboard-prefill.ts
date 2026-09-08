import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";
import type { OnboardPrefillView } from "../../../shared/api-types.ts";
import { OnboardPrefillRequest, readOnboardPrefill } from "./onboard-prefill.ts";

// The wizard's PREFILL route, apart from api.ts the way api-unit-sizes.ts is: the version and the
// channel read off the consumer's repository before any run exists (onboard-prefill.ts). Sealing the
// PAT and purging it again is the reader's own business, so an abandoned wizard leaves no credential
// row behind.

export interface OnboardPrefillApiDeps {
  store: CredentialStore;
  onboardingEnabled: boolean;
  /** The consumer repository reader — the SAME GitRepoReader the onboard run clones with. Absent when
   *  consumer onboarding is not wired ⇒ the route answers 501, like the onboard POST. */
  repo?: RepoReader;
}

export function registerOnboardPrefillRoute(app: Hono<AppEnv>, deps: OnboardPrefillApiDeps): void {
  const { store, onboardingEnabled, repo } = deps;
  app.post("/api/consumers/prefill", async (c) => {
    if (!onboardingEnabled || !repo) throw errNotConfigured("onboarding is not configured on this manager — the gate-runner and git/kube/vault adapters must be wired first");
    const parsed = OnboardPrefillRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation(`invalid onboard prefill request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json((await readOnboardPrefill({ repo, store }, parsed.data, c.req.raw.signal)) satisfies OnboardPrefillView);
  });
}
