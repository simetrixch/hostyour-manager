import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { resolveClusterNameById, resolveClusterIdByName, resolveMasterCluster } from "./read.ts";

describe("the two cluster-name resolvers", () => {
  let db: DbHandle;
  beforeEach(() => {
    db = openDb(":memory:");
    db.db.insert(servers).values({ id: "srv_1", name: "box-a", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example.com", name: "s1", status: "active" }).run();
  });
  afterEach(() => { db.sqlite.close(); });

  it("resolves both directions from the stored cluster name, NOT from the machine name", () => {
    expect(resolveClusterNameById(db.db, "cls_1")).toBe("s1");
    expect(resolveClusterIdByName(db.db, "s1")).toEqual({ clusterId: "cls_1", domain: "s1.example.com" });
    // The server row is called something else entirely; the short name never comes from it.
    expect(resolveClusterIdByName(db.db, "box-a")).toBeNull();
  });

  it("answers null for an unknown cluster", () => {
    expect(resolveClusterNameById(db.db, "cls_missing")).toBeNull();
    expect(resolveClusterIdByName(db.db, "nobody")).toBeNull();
  });
});

describe("resolveMasterCluster", () => {
  let db: DbHandle;
  beforeEach(() => { db = openDb(":memory:"); });
  afterEach(() => { db.sqlite.close(); });

  it("resolves the ONE master-part server's cluster row", () => {
    db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "5.6.7.8", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example.com", name: "m1", status: "active" }).run();
    expect(resolveMasterCluster(db.db)).toEqual({ clusterId: "cls_m", domain: "m1.example.com" });
  });

  it("fails loud (VALIDATION) when no master cluster is registered", () => {
    expect(() => resolveMasterCluster(db.db)).toThrow(/master/);
  });
});
