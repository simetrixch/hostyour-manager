import { describe, it, expect, beforeEach } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AppsManifest } from "../../../shared/apps-manifest.ts";
import type { TenantRegistration } from "../../../shared/tenant.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { ensureTenantAppDatabases } from "./tenant-app-databases.ts";

// The boot's forward step: every standing tenant's apps[] entries get the database list the catalog
// entry of each app's folder declares, and nothing else of the registration changes.

const STALE = "zsjs023ctne0"; // registered before the lists were carried, one list stale
const CURRENT = "q2w3e4r5t6y7"; // every list already stands
const BROKEN = "a1b2c3d4e5f6"; // its registration fails the schema
const UNREGISTERED = "h7j8k9m0n1p2"; // a row, but no registration at its stage
const GONE = "x9w8v7t6s5r4"; // offboarded

const CATALOG: AppsManifest = {
  apps: [
    { name: "erp", title: "ERP", description: "", selections: {}, databases: ["core", "sales"] },
    { name: "crm", title: "CRM", description: "", selections: {} },
    { name: "web", title: "Website", description: "", selections: {}, databases: ["content"] },
  ],
};

const erp = { name: "erp", seedReference: true, seedDemo: false, selections: { extra: true } };
const crm = { name: "crm", seedReference: false, seedDemo: false, selections: {} };
const site = { name: "simetrix-ch", folder: "web", site: "simetrix-ch", domain: "simetrix.ch", seedReference: false, seedDemo: false, selections: {} };

function registration(apps: TenantRegistration["apps"]): TenantRegistration {
  return {
    cluster: "s1", subdomain: "acme", members: testMembers(apps.map((a) => a.name)), identityProvider: "auth", routing: "host",
    ownDomain: "", ownDomainRedirects: [], approvedTags: {}, senderDomain: "", apps, seedUsers: false, quota: seedQuota("small"),
    resetNonce: "1", suspended: false, quiesced: false, appsImage: "", appsImageTag: "",
  };
}

const silent = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as unknown as Logger;

describe("the boot pass over every standing tenant's app database lists", () => {
  let db: DbHandle;
  let repo: FakePlatformRepo;
  let registrations: TenantRegistrations;
  const seed = (guid: string, r: TenantRegistration) => {
    const w = tenantRegistrationWrite("prod", guid, r);
    repo.seed(repo.booksBranch, w.path, w.content);
  };
  const appsOf = async (guid: string) => (await registrations.readTenant("prod", guid))?.entry.apps;

  beforeEach(() => {
    db = openDb(":memory:");
    db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    const tenant = (id: string, guid: string, status: "active" | "offboarded") =>
      db.db.insert(tenants).values({ id, clusterId: "cls_1", guid, subdomain: id, stage: "prod", members: ["auth"], identityProvider: "auth", status }).run();
    tenant("tnt_a", BROKEN, "active");
    tenant("tnt_b", STALE, "active");
    tenant("tnt_c", CURRENT, "active");
    tenant("tnt_d", UNREGISTERED, "active");
    tenant("tnt_e", GONE, "offboarded");
    repo = new FakePlatformRepo();
    registrations = new TenantRegistrations(repo);
    seed(STALE, registration([erp, { ...crm, databases: ["dropped"] }, site]));
    seed(CURRENT, registration([{ ...erp, databases: ["core", "sales"] }]));
    seed(GONE, registration([erp]));
    const broken = tenantRegistrationWrite("prod", BROKEN, registration([erp]));
    repo.seed(repo.booksBranch, broken.path, "cluster: [unclosed");
  });

  it("writes each app's list by its folder, drops one the catalog no longer declares, and changes nothing else", async () => {
    const before = await registrations.readTenant("prod", STALE);
    const result = await ensureTenantAppDatabases({ db: db.db, registrations, readCatalog: async () => CATALOG, logger: silent });
    expect(result).toEqual({ written: [`prod/${STALE}`], failed: [`prod/${BROKEN}`] });
    expect(await appsOf(STALE)).toEqual([{ ...erp, databases: ["core", "sales"] }, crm, { ...site, databases: ["content"] }]);
    const after = await registrations.readTenant("prod", STALE);
    expect({ ...after!.entry, apps: [] }).toEqual({ ...before!.entry, apps: [] });
  });

  it("commits once per tenant whose lists differ: none for a tenant already current, an unregistered one or an offboarded one", async () => {
    await ensureTenantAppDatabases({ db: db.db, registrations, readCatalog: async () => CATALOG, logger: silent });
    expect(repo.commits.map((c) => c.message)).toEqual([`app-databases(${STALE}): erp [core, sales], crm [], simetrix-ch [content] [boot]`]);
    expect(await appsOf(GONE)).toEqual([erp]);
    // A second boot finds every list standing.
    expect(await ensureTenantAppDatabases({ db: db.db, registrations, readCatalog: async () => CATALOG, logger: silent })).toEqual({ written: [], failed: [`prod/${BROKEN}`] });
    expect(repo.commits).toHaveLength(1);
  });

  it("PLANTED DEFECT: writes nothing where the catalog cannot be read, rather than dropping every list", async () => {
    const result = await ensureTenantAppDatabases({ db: db.db, registrations, readCatalog: async () => { throw new Error("clone failed"); }, logger: silent });
    expect(result).toBeNull();
    expect(repo.commits).toEqual([]);
    expect(await appsOf(CURRENT)).toEqual([{ ...erp, databases: ["core", "sales"] }]);
  });
});
