import { eq } from "drizzle-orm";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { GUID, db, seedClusters } from "./add-app.fixture.ts";

// The live tenant the website runs are tried on: its clusters, its registration with websites beside
// erp, and the template catalog whose website folder carries the sites main and shop.

/** The template's catalog with a website folder: `web` carries the sites main and shop. */
export const WEBSITE_APPS = {
  "apps.yaml": "apps:\n  - name: erp\n    title: ERP\n  - name: web\n    title: Website\n    sites: [main, shop]\n",
  "webs/main/website.json": "{}\n",
  "webs/shop/website.json": "{}\n",
};
/** The live tenant of the fixture, on path routing: a website's hosts point at its zone, which has a
 *  record of its own only there. */
export function seedWebsiteTenant(): void {
  seedClusters();
  db.db.update(tenants).set({ routing: "path" }).where(eq(tenants.id, "tnt_1")).run();
}

/** A live tenant whose registration carries `apps` beside erp, and optionally an own domain. */
export function tenantWith(apps: readonly { name: string; [field: string]: string | string[] }[], own: { ownDomain: string; ownDomainRedirects: string[] } = { ownDomain: "", ownDomainRedirects: [] }, repo = new FakePlatformRepo()): TenantRegistrations {
  const all = [{ name: "erp" }, ...apps];
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers(all), identityProvider: "auth", apps: all, quota: seedQuota("small"), ...TEST_BUNDLE,
    ...(own.ownDomain ? { routing: "path", ...own } : {}),
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return new TenantRegistrations(repo);
}
