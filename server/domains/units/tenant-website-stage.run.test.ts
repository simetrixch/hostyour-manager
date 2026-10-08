import { describe, it, expect } from "vitest";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { makeAddAppDef } from "./add-app.run.ts";
import { makeTenantSetWebsiteDomainDef } from "./tenant-website-domain.run.ts";
import { planCtx, ports, useMemoryDb } from "./add-app.fixture.ts";
import { WEBSITE_APPS, seedWebsiteTenant, tenantWith } from "./tenant-website.fixture.ts";

// A website's domain at a stage: the plan refuses one typed now that breaks the stage rule, naming the
// host it would be, and judges neither the domain a move keeps as an alias nor an alias dropped.

useMemoryDb();

const WEBSITE = { tenantId: "tnt_1", app: "main", folder: "web", site: "main", domain: "example.ch" };
const MOVE = { tenantId: "tnt_1", app: "example-ch", domain: "example.org" };

describe("add-app for a website, and the stage rule", () => {
  it("PLANTED DEFECT: refuses at prod a website domain with a stage label before its zone, naming the prod host", async () => {
    seedWebsiteTenant();
    const dns = new FakeDnsProvider();
    dns.zones = ["example.org"];
    const def = makeAddAppDef(ports({ dns }, WEBSITE_APPS));
    await expect(def.planStream!({ ...WEBSITE, domain: "cycleshop.show.test.example.org" }, planCtx())).rejects.toThrow(/carries the stage test before its zone example\.org, and prod carries none: it is cycleshop\.show\.example\.org/);
  });
});

describe("tenant-set-website-domain, and the stage rule", () => {
  it("PLANTED DEFECT: refuses at prod a new domain or a new alias with a stage label before its zone, naming the prod host", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "example.ch" }]);
    const dns = new FakeDnsProvider();
    dns.zones = ["example.org"];
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations, dns }, WEBSITE_APPS));
    await expect(def.planStream!({ ...MOVE, domain: "shop.test.example.org" }, planCtx())).rejects.toThrow(/it is shop\.example\.org$/);
    await expect(def.planStream!({ ...MOVE, domain: "example.org", aliases: ["shop.dev.example.org"] }, planCtx())).rejects.toThrow(/carries the stage dev before its zone example\.org/);
  });

  it("PLANTED INNOCENT: moves a website off a domain that breaks the rule, which the move keeps as an alias, and drops that alias", async () => {
    seedWebsiteTenant();
    const registrations = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "shop.test.example.org" }]);
    const dns = new FakeDnsProvider();
    dns.zones = ["example.org"];
    const def = makeTenantSetWebsiteDomainDef(ports({ registrations, dns }, WEBSITE_APPS));
    const moved = await def.planStream!({ ...MOVE, domain: "shop.example.org" }, planCtx());
    expect(moved.outcome === "planned" ? moved.params.aliases : moved.summary).toEqual(["shop.test.example.org"]);
    const standing = tenantWith([{ name: "example-ch", folder: "web", site: "main", domain: "shop.example.org", aliases: ["shop.test.example.org"] }]);
    const dropped = await makeTenantSetWebsiteDomainDef(ports({ registrations: standing, dns }, WEBSITE_APPS)).planStream!({ ...MOVE, domain: "shop.example.org", aliases: [] }, planCtx());
    expect(dropped.outcome === "planned" ? dropped.params.aliases : dropped.summary).toEqual([]);
  });
});
