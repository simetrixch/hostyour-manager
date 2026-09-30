import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { customerHostProblem } from "./own-domain-records.ts";

// One host serves one tenant, and a host of a tenant never lies under or above another tenant's host,
// except where the operator confirmed that one tenant's hosts lie under the other's.

const APEX = "digitacloud.app";

describe("customerHostProblem — another tenant's host, and confirmed nesting", () => {
  let db: DbHandle;
  const tenant = (id: string, guid: string, subdomain: string, ownDomain: string): void => {
    db.db.insert(tenants).values({
      id, clusterId: "cls_1", guid, subdomain, stage: "prod", members: ["auth"], identityProvider: "auth", routing: "path",
      ownDomain, ownDomainRedirects: ownDomain ? [`www.${ownDomain}`] : [], suspended: false, status: "active",
    }).run();
  };
  const nest = (id: string, under: string | null, ownDomain?: string): void => {
    db.db.update(tenants).set({ nestsUnder: under, ...(ownDomain ? { ownDomain, ownDomainRedirects: [`www.${ownDomain}`] } : {}) }).where(eq(tenants.id, id)).run();
  };

  beforeEach(() => {
    db = openDb(":memory:");
    db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "apps1.digitacloud.app", name: "apps1", status: "active" }).run();
    tenant("tnt_sim", "a1a1a1a1a1a1", "simetrix", "digitaplatform.com");
    tenant("tnt_show", "b2b2b2b2b2b2", "show", "");
    tenant("tnt_other", "c3c3c3c3c3c3", "other", "other.example");
  });

  it("refuses a host under another tenant's host without a confirmation, and says how to confirm it", () => {
    expect(customerHostProblem(db.db, "tnt_show", "show.digitaplatform.com", APEX)).toBe(
      "show.digitaplatform.com overlaps a host of tenant simetrix (digitaplatform.com) — where both tenants are one owner's, confirm in Set own domain that this tenant's domain lies under tenant simetrix",
    );
  });

  it("lets a host lie under the host of the tenant it nests under: confirmed in the plan, then recorded on the row, a website host of it included", () => {
    expect(customerHostProblem(db.db, "tnt_show", "show.digitaplatform.com", APEX, [], "tnt_sim")).toBeNull();
    nest("tnt_show", "tnt_sim");
    expect(customerHostProblem(db.db, "tnt_show", "veloluck.show.digitaplatform.com", APEX)).toBeNull();
    expect(customerHostProblem(db.db, "tnt_show", "www.show.digitaplatform.com", APEX, [{ host: "digitaplatform.com", subdomain: "simetrix", guid: "a1a1a1a1a1a1" }])).toBeNull();
  });

  it("lets the tenant nested under keep its own hosts above the nested tenant's", () => {
    nest("tnt_show", "tnt_sim", "show.digitaplatform.com");
    expect(customerHostProblem(db.db, "tnt_sim", "digitaplatform.com", APEX)).toBeNull();
    expect(customerHostProblem(db.db, "tnt_sim", "www.digitaplatform.com", APEX)).toBeNull();
  });

  it("PLANTED DEFECT: refuses the exact same host even when confirmed, a host under a third tenant, and a host above a tenant that nests under nobody", () => {
    expect(customerHostProblem(db.db, "tnt_show", "digitaplatform.com", APEX, [], "tnt_sim")).toBe("digitaplatform.com is already a host of tenant simetrix (digitaplatform.com)");
    expect(customerHostProblem(db.db, "tnt_show", "shop.other.example", APEX, [], "tnt_sim")).toMatch(/overlaps a host of tenant other \(other.example\)/);
    nest("tnt_show", null, "x.other.example");
    expect(customerHostProblem(db.db, "tnt_other", "other.example", APEX)).toBe("other.example overlaps a host of tenant show (x.other.example)");
    expect(customerHostProblem(db.db, "tnt_show", "show.digitaplatform.com", APEX, [{ host: "digitaplatform.com", subdomain: "simetrix", guid: "a1a1a1a1a1a1" }], null)).toMatch(/overlaps a host of tenant simetrix/);
  });
});
