import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { resolveTenantCluster, registryHostFromChain } from "./tenant-values.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

describe("registryHostFromChain", () => {
  const common = { path: "clusters/platform/values-common.yaml", content: "global:\n  endpoints:\n    registry:\n      host: zot.m1.example.com\n" };
  const stage = { path: "clusters/platform/values-prod.yaml", content: "global: {}\n" };

  it("takes the LAST file that states it — the cluster's own profile wins over the platform default", () => {
    const profile = { path: clusterMapPath("m1.example"), content: "global:\n  endpoints:\n    registry:\n      host: zot.s1.example.com\n" };
    expect(registryHostFromChain([common, stage, profile])).toBe("zot.s1.example.com");
  });

  it("follows a build plane that is NOT the cluster's master — the profile's host is the answer, never zot.<master>", () => {
    // set-role.sh writes the profile as zot.<build-plane>; with --build-plane pointing at a foreign
    // cluster this is the registrations the cluster actually pulls from, while the master is m1.
    const profile = { path: clusterMapPath("m1.example"), content: "global:\n  endpoints:\n    registry:\n      host: zot.build1.example.com\n" };
    expect(registryHostFromChain([common, stage, profile])).toBe("zot.build1.example.com");
  });

  it("falls back through the chain when the profile states none", () => {
    expect(registryHostFromChain([common, stage, { path: clusterMapPath("m1.example"), content: "global: {}\n" }])).toBe("zot.m1.example.com");
  });

  it("fails loud (VALIDATION) naming the files read when NO file states a registry host", () => {
    expect(() => registryHostFromChain([stage])).toThrowError(/platform\/values-prod\.yaml/);
  });
});

describe("resolveTenantCluster — the tenant's stage is one the cluster carries", () => {
  let db: DbHandle;
  beforeEach(() => {
    db = openDb(":memory:");
    db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example.com", name: "s1", status: "active" }).run();
  });
  afterEach(() => { db.sqlite.close(); });

  it("resolves the domain, the short name and the stage of an active cluster at the tenant's stage", () => {
    expect(resolveTenantCluster(db.db, "cls_1", "prod")).toEqual({ clusterId: "cls_1", domain: "s1.example.com", cluster: "s1", stage: "prod" });
  });

  it("places a customer's test stage on a prod cluster, which holds tenant-eso-test beside tenant-eso-prod (#295)", () => {
    expect(resolveTenantCluster(db.db, "cls_1", "test")).toEqual({ clusterId: "cls_1", domain: "s1.example.com", cluster: "s1", stage: "prod" });
  });

  it("PLANTED DEFECT: refuses a stage the cluster carries no tenant role for, naming the roles it holds", () => {
    // A dev tenant on a prod cluster would log in with tenant-eso-dev, a role the cluster does not hold.
    expect(() => resolveTenantCluster(db.db, "cls_1", "dev")).toThrow(/tenant at dev cannot be created on s1\.example\.com, a prod cluster.*tenant-eso-prod and tenant-eso-test alone.*create it at prod or test/);
    // A test cluster carries its own stage alone: a prod tenant there is refused.
    db.db.update(clusters).set({ stage: "test" }).run();
    expect(() => resolveTenantCluster(db.db, "cls_1", "prod")).toThrow(/tenant at prod cannot be created on s1\.example\.com, a test cluster.*tenant-eso-test alone.*create it at test$/);
  });

  it("refuses a cluster that is not active, and an unknown one", () => {
    db.db.update(clusters).set({ status: "provisioning" }).run();
    expect(() => resolveTenantCluster(db.db, "cls_1", "prod")).toThrow(/not active/);
    expect(() => resolveTenantCluster(db.db, "cls_9", "prod")).toThrow(/cls_9/);
  });
});
