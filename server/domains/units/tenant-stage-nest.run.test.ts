import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { clusters, servers, tenants } from "../../db/schema/inventory.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import type { Stage } from "../../../shared/enums.ts";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { makeTenantSetWebsiteDomainDef } from "./tenant-website-domain.run.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { GUID, db, planCtx, ports, useMemoryDb, seedClusters } from "./add-app.fixture.ts";
import { WEBSITE_APPS } from "./tenant-website.fixture.ts";

// One tenant at two stages under one zone: the stage rule puts every test host at
// <x>.test.<zone>, under the zone's apex. That nesting is the rule's own, so a site at the apex at
// prod and a test host under it are no overlap; any other one is.

useMemoryDb();

const ZONE = "example.net";
const SITE = { name: "simetrix-ch", site: "main" };

function registered(stage: Stage, own: string, site: { domain: string }): TenantRegistrations {
  const repo = new FakePlatformRepo();
  const all = [{ name: "erp" }, { folder: "web", ...SITE, ...site }];
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "simetrix", members: testMembers(all), identityProvider: "auth", apps: all, quota: seedQuota("small"), ...TEST_BUNDLE,
    ownDomain: own, ownDomainRedirects: [`www.${own}`],
  });
  const w = tenantRegistrationWrite(stage, GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return new TenantRegistrations(repo);
}

/** tnt_1 at `stage` on `own`, and a second row `other` holding `otherOwn` at the other stage. */
function world(stage: Stage, own: string, other: { guid: string; stage: Stage; own: string }): FakeDnsProvider {
  seedClusters();
  db.db.update(clusters).set({ stage }).where(eq(clusters.id, "cls_1")).run();
  db.db.update(tenants).set({ stage, subdomain: "simetrix", ownDomain: own, ownDomainRedirects: [`www.${own}`], ownDomainAliases: [] }).where(eq(tenants.id, "tnt_1")).run();
  db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "10.1.1.12", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: other.stage, domain: "s2.example", name: "s2", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_2", clusterId: "cls_2", guid: other.guid, subdomain: other.guid === GUID ? "simetrix" : "other", stage: other.stage,
    members: ["auth"], identityProvider: "auth", ownDomain: other.own, ownDomainRedirects: [`www.${other.own}`], status: "active" }).run();
  const dns = new FakeDnsProvider();
  dns.zones = [ZONE];
  return dns;
}

const plan = (dns: FakeDnsProvider, registrations: TenantRegistrations, domain: string) =>
  makeTenantSetWebsiteDomainDef(ports({ registrations, dns }, WEBSITE_APPS)).planStream!({ tenantId: "tnt_1", app: SITE.name, domain, aliases: [] }, planCtx());

describe("one tenant at two stages under one zone", () => {
  it("PLANTED DEFECT: moves the prod company site onto the zone's apex while its test stage stands under it", async () => {
    const dns = world("prod", "hub.example.net", { guid: GUID, stage: "test", own: "hub.test.example.net" });
    const planned = await plan(dns, registered("prod", "hub.example.net", { domain: "example.org" }), ZONE);
    expect(planned.outcome === "planned" ? planned.params.domain : planned.summary).toBe(ZONE);
  });

  it("PLANTED DEFECT: moves a test site under the zone while its prod stage stands at the apex", async () => {
    const dns = world("test", "hub.test.example.net", { guid: GUID, stage: "prod", own: ZONE });
    const planned = await plan(dns, registered("test", "hub.test.example.net", { domain: "web.test.example.org" }), "site.test.example.net");
    expect(planned.outcome === "planned" ? planned.params.domain : planned.summary).toBe("site.test.example.net");
  });

  it("PLANTED INNOCENT: still refuses another tenant's test host under the apex", async () => {
    const dns = world("prod", "hub.example.net", { guid: "zzzzzzzzzzzz", stage: "test", own: "hub.test.example.net" });
    await expect(plan(dns, registered("prod", "hub.example.net", { domain: "example.org" }), ZONE)).rejects.toThrow(/overlaps a host of tenant other \(hub\.test\.example\.net\)/);
  });

  it("PLANTED INNOCENT: still refuses the same tenant's nest that is not shaped by the stage rule", async () => {
    const dns = world("prod", "hub.example.net", { guid: GUID, stage: "test", own: "legacy.example.net" });
    await expect(plan(dns, registered("prod", "hub.example.net", { domain: "example.org" }), ZONE)).rejects.toThrow(/overlaps a host of tenant simetrix at test \(legacy\.example\.net\)/);
  });

  it("PLANTED INNOCENT: still refuses a host the same tenant holds at its other stage", async () => {
    const dns = world("prod", "hub.example.net", { guid: GUID, stage: "test", own: "site.example.net" });
    await expect(plan(dns, registered("prod", "hub.example.net", { domain: "example.org" }), "site.example.net")).rejects.toThrow(/site\.example\.net is already a host of tenant simetrix at test/);
  });

  it("PLANTED INNOCENT: still refuses a test host above the same tenant's prod host, which no stage rule nests", async () => {
    const dns = world("test", "hub.test.example.net", { guid: GUID, stage: "prod", own: "hub.example.net" });
    await expect(plan(dns, registered("test", "hub.test.example.net", { domain: "web.test.example.org" }), ZONE)).rejects.toThrow(/overlaps a host of tenant simetrix at prod \(hub\.example\.net\)/);
  });
});
