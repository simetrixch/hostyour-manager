import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../http/app-env.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { OwnersListView } from "../../../shared/api-types-owners.ts";
import { assertOrgLogin, forgetOwnerCredential, listOwnerIdentities, recordPackagesReader, recordRepositoryPat, type OwnerDeps } from "#unit/server/owners.ts";

// The owner identities over HTTP (hostyour-manager#219): the list, and one PUT per
// credential — the token rides the body once over TLS, is measured and sealed by the domain, and
// the answer carries its fingerprint only. A zod refusal names the field, never the value.
const CredentialBody = z.object({ token: z.string().min(1) });

export function registerOwnerRoutes(app: Hono<AppEnv>, deps: OwnerDeps): void {
  app.get("/api/owners", async (c) => c.json({ owners: await listOwnerIdentities(deps, c.req.raw.signal) } satisfies OwnersListView));

  app.put("/api/owners/:org/packages-reader", async (c) => {
    const org = assertOrgLogin(c.req.param("org"));
    const parsed = CredentialBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation("the packages reader is one field, token, and it was not given");
    return c.json({ packagesReader: await recordPackagesReader(deps, org, parsed.data.token, c.req.raw.signal) });
  });

  app.put("/api/owners/:org/repository-pat", async (c) => {
    const org = assertOrgLogin(c.req.param("org"));
    const parsed = CredentialBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation("the repository PAT is one field, token, and it was not given");
    return c.json({ repositoryPat: await recordRepositoryPat(deps, org, parsed.data.token, c.req.raw.signal) });
  });

  app.delete("/api/owners/:org/packages-reader", async (c) => {
    await forgetOwnerCredential(deps, assertOrgLogin(c.req.param("org")), "packages-reader");
    return c.json({ ok: true });
  });

  app.delete("/api/owners/:org/repository-pat", async (c) => {
    await forgetOwnerCredential(deps, assertOrgLogin(c.req.param("org")), "repository-pat");
    return c.json({ ok: true });
  });
}
