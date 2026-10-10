import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { clusters, servers, tenants } from "../../db/schema/inventory.ts";
import type { Stage } from "../../../shared/enums.ts";
import { customerHostProblem } from "./own-domain-records.ts";
import { GUID, db, useMemoryDb, seedClusters } from "./add-app.fixture.ts";

// One tenant at two stages under one zone: the stage rule puts every test host at
// <x>.test.<zone>, under the zone's apex. That nesting is the rule's own, so a host at the apex at
// prod and a test host under it are no overlap; any other one is.

useMemoryDb();

const ZONE = "example.net";

/** tnt_1 at `stage` on `own`, and a second row `other` holding `otherOwn` at the other stage. */
function world(stage: Stage, own: string, other: { guid: string; stage: Stage; own: string }): void {
  seedClusters();
  db.db.update(clusters).set({ stage }).where(eq(clusters.id, "cls_1")).run();
  db.db.update(tenants).set({ stage, subdomain: "simetrix", ownDomain: own, ownDomainRedirects: [`www.${own}`], ownDomainAliases: [] }).where(eq(tenants.id, "tnt_1")).run();
  db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "10.1.1.12", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_2", serverId: "srv_2", stage: other.stage, domain: "s2.example", name: "s2", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_2", clusterId: "cls_2", guid: other.guid, subdomain: other.guid === GUID ? "simetrix" : "other", stage: other.stage,
    members: ["auth"], identityProvider: "auth", ownDomain: other.own, ownDomainRedirects: [`www.${other.own}`], status: "active" }).run();
}

/** What the own-domain plan says of `host` for tnt_1: nothing, or why it refuses it. */
const judged = (host: string): string | null => customerHostProblem(db.db, "tnt_1", host, "digitacloud.app");

describe("one tenant at two stages under one zone", () => {
  it("PLANTED DEFECT: takes the zone's apex for the prod tenant while its test stage stands under it", async () => {
    world("prod", "hub.example.net", { guid: GUID, stage: "test", own: "hub.test.example.net" });
    expect(judged(ZONE)).toBeNull();
  });

  it("PLANTED DEFECT: takes a test host under the zone while its prod stage stands at the apex", async () => {
    world("test", "hub.test.example.net", { guid: GUID, stage: "prod", own: ZONE });
    expect(judged("site.test.example.net")).toBeNull();
  });

  it("PLANTED INNOCENT: still refuses another tenant's test host under the apex", async () => {
    world("prod", "hub.example.net", { guid: "zzzzzzzzzzzz", stage: "test", own: "hub.test.example.net" });
    expect(judged(ZONE)).toMatch(/overlaps a host of tenant other \(hub\.test\.example\.net\)/);
  });

  it("PLANTED INNOCENT: still refuses the same tenant's nest that is not shaped by the stage rule", async () => {
    world("prod", "hub.example.net", { guid: GUID, stage: "test", own: "legacy.example.net" });
    expect(judged(ZONE)).toMatch(/overlaps a host of tenant simetrix at test \(legacy\.example\.net\)/);
  });

  it("PLANTED INNOCENT: still refuses a host the same tenant holds at its other stage", async () => {
    world("prod", "hub.example.net", { guid: GUID, stage: "test", own: "site.example.net" });
    expect(judged("site.example.net")).toMatch(/site\.example\.net is already a host of tenant simetrix at test/);
  });

  it("PLANTED INNOCENT: still refuses a test host above the same tenant's prod host, which no stage rule nests", async () => {
    world("test", "hub.test.example.net", { guid: GUID, stage: "prod", own: "hub.example.net" });
    expect(judged(ZONE)).toMatch(/overlaps a host of tenant simetrix at prod \(hub\.example\.net\)/);
  });
});
