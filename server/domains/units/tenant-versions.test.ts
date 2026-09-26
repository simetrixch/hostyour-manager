import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { fixTenantVersions, sameApprovals, stagePinsOf, withMissingPins, withNewestPins, type Approvals } from "./tenant-versions.ts";
import type { Logger } from "../../kernel/logger.ts";

// The versions a tenant runs: the stage pins it starts on, the builds the boot fixes at the version
// they run, and the comparison that makes a current tenant a run with nothing to do.

const GUID = "zsjs023ctne0";
const NEW = "0.1.12-stable-20260925120000-abc1234";
const OLD = "0.1.11-stable-20260920120000-def5678";

const pinsFile = (builds: Record<string, string>): string =>
  `builds:\n${Object.entries(builds).map(([name, tag]) => `  - { name: ${name}, image: ${name}, tag: "${tag}" }`).join("\n")}\n`;

/** One tenant at prod holding `approvedTags`, and the stage pins of two of its charts: the engine's
 *  second build still carries its placeholder, which names no released image. */
function books(approvedTags: Approvals): TenantRegistrations {
  const repo = new FakePlatformRepo();
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers(["erp"]), identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"), approvedTags, ...TEST_BUNDLE,
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  repo.seed(repo.booksBranch, "charts/example-auth/pins-prod.yaml", pinsFile({ "example-auth": NEW }));
  repo.seed(repo.booksBranch, "charts/example-engine/pins-prod.yaml", pinsFile({ "example-engine": NEW, "example-migrate": "" }));
  return new TenantRegistrations(repo);
}

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

const logs: string[] = [];
const logger = { info: (_o: unknown, m: string) => logs.push(m), error: (_o: unknown, m: string) => logs.push(m) } as unknown as Logger;

describe("tenant versions", () => {
  it("takes the stage pin of every build a member's charts pin, and leaves a placeholder out", async () => {
    const registrations = books({});
    const pins = await stagePinsOf((chart) => registrations.listPinnedBuilds("prod", chart), testMembers(["erp"]));
    expect(pins).toEqual({ auth: { "example-auth": NEW }, erp: { "example-engine": NEW } });
  });

  it("adds only the builds a tenant does not hold yet, and compares approvals in any order", () => {
    const current = { erp: { "example-engine": OLD } };
    const next = withMissingPins(current, { auth: { "example-auth": NEW }, erp: { "example-engine": NEW } });
    expect(next).toEqual({ erp: { "example-engine": OLD }, auth: { "example-auth": NEW } });
    expect(current).toEqual({ erp: { "example-engine": OLD } });
    expect(sameApprovals(next, { auth: { "example-auth": NEW }, erp: { "example-engine": OLD } })).toBe(true);
    expect(sameApprovals(next, { auth: { "example-auth": NEW }, erp: { "example-engine": NEW } })).toBe(false);
  });

  it("an upgrade moves every pinned build onto its pin and keeps a build no pin names", () => {
    const current = { erp: { "example-engine": OLD, "example-kept": OLD } };
    expect(withNewestPins(current, { erp: { "example-engine": NEW }, auth: { "example-auth": NEW } }))
      .toEqual({ erp: { "example-engine": NEW, "example-kept": OLD }, auth: { "example-auth": NEW } });
    expect(current.erp["example-engine"]).toBe(OLD);
  });

  it("the boot fixes a missing build at the version it runs, keeps a held one, and commits nothing the second time", async () => {
    const registrations = books({ erp: { "example-engine": OLD } });
    let writes = 0;
    const setApprovedTags = registrations.setApprovedTags.bind(registrations);
    registrations.setApprovedTags = async (...args) => { writes++; return setApprovedTags(...args); };
    await fixTenantVersions({ registrations, db: db.db, version: "0.8.0", logger });
    const want = { erp: { "example-engine": OLD }, auth: { "example-auth": NEW } };
    expect((await registrations.readTenant("prod", GUID))?.entry.approvedTags).toEqual(want);
    expect(db.db.select({ a: tenants.approvedTags }).from(tenants).get()?.a).toEqual(want);
    await fixTenantVersions({ registrations, db: db.db, version: "0.8.0", logger });
    expect(writes).toBe(1);
  });

  it("the boot never rejects: a stage it cannot read is logged and the other stages are fixed", async () => {
    const registrations = books({});
    const listTenantPointers = registrations.listTenantPointers.bind(registrations);
    registrations.listTenantPointers = async (stage) => { if (stage === "dev") throw new Error("books unreadable"); return listTenantPointers(stage); };
    await expect(fixTenantVersions({ registrations, db: db.db, version: "0.8.0", logger })).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("could not be fixed"))).toBe(true);
    expect((await registrations.readTenant("prod", GUID))?.entry.approvedTags).toEqual({ auth: { "example-auth": NEW }, erp: { "example-engine": NEW } });
  });
});
