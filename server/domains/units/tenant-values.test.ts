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

describe("resolveTenantCluster — a tenant stage stands only on a machine that serves its stage", () => {
  let db: DbHandle;
  beforeEach(() => {
    db = openDb(":memory:");
    db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example.com", name: "s1", status: "active" }).run();
  });
  afterEach(() => { db.sqlite.close(); });

  it("PLANTED INNOCENT: resolves the domain, the short name and the stage of an active machine of the tenant's stage", () => {
    expect(resolveTenantCluster(db.db, "cls_1", "prod")).toEqual({ clusterId: "cls_1", domain: "s1.example.com", cluster: "s1", stage: "prod" });
  });

  it("PLANTED DEFECT: refuses TEST on a PROD machine, naming the machine and both stages", () => {
    expect(() => resolveTenantCluster(db.db, "cls_1", "test")).toThrow("machine s1 (s1.example.com) serves prod environments only and cannot take a test environment");
  });

  it("PLANTED DEFECT: refuses PROD on a TEST machine, and takes TEST there", () => {
    db.db.update(clusters).set({ stage: "test" }).run();
    expect(() => resolveTenantCluster(db.db, "cls_1", "prod")).toThrow("machine s1 (s1.example.com) serves test environments only and cannot take a prod environment");
    expect(resolveTenantCluster(db.db, "cls_1", "test").clusterId).toBe("cls_1");
  });

  it("refuses a cluster that is not active, and an unknown one", () => {
    db.db.update(clusters).set({ status: "provisioning" }).run();
    expect(() => resolveTenantCluster(db.db, "cls_1", "prod")).toThrow(/not active/);
    expect(() => resolveTenantCluster(db.db, "cls_9", "prod")).toThrow(/cls_9/);
  });
});
