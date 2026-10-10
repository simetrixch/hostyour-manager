import { seedQuota } from "#unit/shared/unit-size.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import type { AddAppPorts } from "./add-app.run.ts";
import { GUID, ports, scriptBundle } from "./add-app.fixture.ts";

// The live tenant the website runs are tried on: its clusters, its registration with websites beside
// erp, and the template catalog whose website folder carries the sites main and shop.

/** The template's catalog with a website folder: `web` carries the sites main and shop. */
export const WEBSITE_APPS = {
  "apps.yaml": "apps:\n  - name: erp\n    title: ERP\n  - name: web\n    title: Website\n    sites: [main, shop]\n",
  "webs/main/website.json": "{}\n",
  "webs/shop/website.json": "{}\n",
};
/** The ports of a website add-app run: the fixture's tenant runs a bundle created from the template, so
 *  at the release it stands at the bundle carries the website folder as the template does. */
export function websitePorts(over: Parameters<typeof ports>[0] = {}, template: Record<string, string> = WEBSITE_APPS): AddAppPorts {
  const prt = ports(over, template);
  scriptBundle(prt, { "apps.yaml": template["apps.yaml"]! });
  return prt;
}

/** A live tenant whose registration carries `apps` beside erp, and optionally an own domain. */
export function tenantWith(apps: readonly { name: string; [field: string]: string | string[] | boolean }[], own: { ownDomain: string; ownDomainRedirects: string[] } = { ownDomain: "", ownDomainRedirects: [] }, repo = new FakePlatformRepo()): TenantRegistrations {
  const all = [{ name: "erp" }, ...apps];
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers(all), identityProvider: "auth", apps: all, quota: seedQuota("small"), ...TEST_BUNDLE,
    ...(own.ownDomain ? { ...own } : {}),
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return new TenantRegistrations(repo);
}
