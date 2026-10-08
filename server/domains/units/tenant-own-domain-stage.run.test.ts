import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { tenants } from "../../db/schema/inventory.ts";
import { useOwnDomainHarness } from "./tenant-own-domain.fixture.ts";

// An own domain at a dev or test stage puts the stage directly before the zone that holds it, and a
// prod one carries no stage: the plan refuses a host typed now that breaks the rule, naming the host
// it would be. The previous domain a move keeps as an alias, and an alias dropped, are not judged.

describe("tenant-set-own-domain and the stage rule", () => {
  const { make, plan } = useOwnDomainHarness();

  it("PLANTED DEFECT: refuses at test an own domain or a new alias with the stage in front of the whole name, naming the host it is", async () => {
    const h = await make({ stage: "test" });
    h.dns.zones = ["example.org"];
    expect((await plan(h, { ownDomain: "test.show.example.org", previous: "" })).error).toMatch(/test\.show\.example\.org is no test host: the stage stands directly before the zone example\.org, so it is show\.test\.example\.org/);
    expect((await plan(h, { ownDomain: "show.test.example.org", previous: "", ownDomainAliases: ["test.cycleshop.show.example.org"] })).error).toMatch(/so it is cycleshop\.show\.test\.example\.org/);
    expect((await plan(h, { ownDomain: "show.test.example.org", previous: "" })).status).toBe("planned");
  });

  it("PLANTED INNOCENT: moves a test tenant off a domain of the old shape, which the move keeps as an alias, and drops that alias", async () => {
    const h = await make({ stage: "test", ownDomain: "test.show.example.org" });
    h.dns.zones = ["example.org"];
    expect((await plan(h, { ownDomain: "show.test.example.org", previous: "test.show.example.org" })).status).toBe("planned");
    // Where the move stands, the previous domain is an alias; a run that only drops it judges nothing.
    h.db.db.update(tenants).set({ ownDomain: "show.test.example.org", ownDomainAliases: ["test.show.example.org"] }).where(eq(tenants.id, "tnt_1")).run();
    expect((await plan(h, { ownDomain: "show.test.example.org", previous: "show.test.example.org", previousAliases: ["test.show.example.org"] })).status).toBe("planned");
  });

  it("PLANTED INNOCENT: plans a request that sends a standing alias of the old shape again, the domain unchanged", async () => {
    const h = await make({ stage: "test", ownDomain: "show.test.example.org" });
    h.dns.zones = ["example.org"];
    h.db.db.update(tenants).set({ ownDomainAliases: ["test.show.example.org"] }).where(eq(tenants.id, "tnt_1")).run();
    // The dialog sends the standing list back as it is; nothing in it is typed now.
    const resent = await plan(h, { ownDomain: "show.test.example.org", previous: "show.test.example.org", ownDomainAliases: ["test.show.example.org"], previousAliases: ["test.show.example.org"] });
    expect(resent.status).toBe("planned");
  });

  it("refuses at prod an own domain with a stage label before its zone, and leaves a domain whose zone is held elsewhere unjudged", async () => {
    const h = await make({ unmanaged: ["elsewhere.example"] });
    h.dns.zones = ["example.org"];
    expect((await plan(h, { ownDomain: "show.test.example.org", previous: "" })).error).toMatch(/carries the stage test before its zone example\.org, and prod carries none: it is show\.example\.org/);
    const unjudged = await plan(h, { ownDomain: "test.shop.elsewhere.example", previous: "" });
    expect(unjudged.error).toMatch(/the stage rule is not checked for test\.shop\.elsewhere\.example/);
  });
});
