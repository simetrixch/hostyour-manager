import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { resolveClusterNameById, resolveClusterIdByName, resolveMasterCluster, registryHostFromChain } from "./tenant-values.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

describe("the two cluster-name resolvers", () => {
  let db: DbHandle;
  beforeEach(() => {
    db = openDb(":memory:");
    db.db.insert(servers).values({ id: "srv_1", name: "box-a", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example.com", status: "active" }).run();
  });
  afterEach(() => { db.sqlite.close(); });

  it("resolves both directions from clusters.domain, NOT from the machine name", () => {
    expect(resolveClusterNameById(db.db, "cls_1")).toBe("s1");
    expect(resolveClusterIdByName(db.db, "s1", "prod")).toEqual({ clusterId: "cls_1", domain: "s1.example.com" });
    // The server row is called something else entirely; the short name never comes from it.
    expect(resolveClusterIdByName(db.db, "box-a", "prod")).toBeNull();
  });

  it("answers null for an unknown cluster and for the right name at the wrong stage", () => {
    expect(resolveClusterNameById(db.db, "cls_missing")).toBeNull();
    expect(resolveClusterIdByName(db.db, "s1", "dev")).toBeNull();
  });
});

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

describe("resolveMasterCluster", () => {
  let db: DbHandle;
  beforeEach(() => { db = openDb(":memory:"); });
  afterEach(() => { db.sqlite.close(); });

  it("resolves the ONE master-part server's cluster row", () => {
    db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "5.6.7.8", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example.com", status: "active" }).run();
    expect(resolveMasterCluster(db.db)).toEqual({ clusterId: "cls_m", domain: "m1.example.com" });
  });

  it("fails loud (VALIDATION) when no master cluster is registered", () => {
    expect(() => resolveMasterCluster(db.db)).toThrow(/master/);
  });
});
