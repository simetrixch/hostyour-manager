import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { apps, clusters, servers, tenants } from "../../db/schema/inventory.ts";
import { listDnsWrites } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { repointUnitRecords } from "./cluster-rename-records.ts";

// A RENAMED CLUSTER'S UNIT RECORDS: every one that names the old FQDN names the new one, the book
// says so, and a record pointing anywhere else — or a unit that is settled — is left as it stands.

const FROM = "s1.example";
const TO = "s1.elsewhere.example";

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: FROM, sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: TO, name: "s1", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_post", clusterId: "cls_1", name: "post", stage: "prod", host: "post", provenance: "manager", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_auth", clusterId: "cls_1", name: "auth", stage: "prod", host: "auth", provenance: "manager", status: "active" }).run();
  db.db.insert(apps).values({ id: "app_gone", clusterId: "cls_1", name: "gone", stage: "prod", host: "gone", provenance: "manager", status: "offboarded" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: "zsjs023ctne0", subdomain: "acme", stage: "prod", members: ["auth"], identityProvider: "auth", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

function ctx(logs: string[]): StepCtx {
  return {
    runId: "run_rename", stepName: "repoint-unit-records", db: db.db, creds: {} as unknown as CredentialStore, params: {},
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("repointUnitRecords", () => {
  it("moves every record naming the old FQDN, enters each into the book, and leaves one pointing elsewhere and a settled unit's", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("post.example.net", "CNAME", FROM);
    dns.seed("auth.example.net", "CNAME", "s2.example");
    dns.seed("gone.example.net", "CNAME", FROM);
    dns.seed("*.acme.example.net", "CNAME", FROM);
    const logs: string[] = [];
    const unitApex = async (domain: string) => { expect(domain).toBe(TO); return "example.net"; };

    const moved = await repointUnitRecords({ dns, unitApex }, ctx(logs), { clusterId: "cls_1", from: FROM, to: TO });

    expect(moved.sort()).toEqual(["*.acme.example.net", "post.example.net"]);
    expect(dns.record("post.example.net", "CNAME")).toBe(TO);
    expect(dns.record("*.acme.example.net", "CNAME")).toBe(TO);
    expect(dns.record("auth.example.net", "CNAME")).toBe("s2.example");
    expect(dns.record("gone.example.net", "CNAME")).toBe(FROM);
    expect(logs.join("\n")).toContain("auth.example.net points at s2.example, not at s1.example — it is not this cluster's to move");
    expect(listDnsWrites(db.db).map((w) => [w.name, w.act, w.content, w.runId]).sort()).toEqual([
      ["*.acme.example.net", "updated", TO, "run_rename"],
      ["post.example.net", "updated", TO, "run_rename"],
    ]);

    // AGAIN, AND NOTHING MORE MOVES: a record already naming the new FQDN is said so and left.
    expect(await repointUnitRecords({ dns, unitApex }, ctx(logs), { clusterId: "cls_1", from: FROM, to: TO })).toEqual([]);
    expect(logs.join("\n")).toContain(`post.example.net already points at ${TO}`);
  });

  it("refuses without a DNS provider, before it reads anything", async () => {
    await expect(repointUnitRecords({ dns: undefined, unitApex: async () => "example.net" }, ctx([]), { clusterId: "cls_1", from: FROM, to: TO }))
      .rejects.toThrow(/requires the DNS provider/);
  });
});
