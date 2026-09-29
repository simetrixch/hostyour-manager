import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TenantAppKeySeedInput, VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import { TENANT_APP_KEY_PROPERTY, ensureTenantAppKeys, seedPasswordFieldKeyStep, seedTenantAppKeys } from "./tenant-app-keys.ts";

// Every tenant app's Password field key (hostyour-manager#329): one per app, 32 random bytes as
// base64, written create-only into the app's own entry below the tenant's.

/** A seeder that remembers every key it was handed, and answers "exists" for the apps in [standing]. */
function recordingSeeder(standing: string[] = [], failFor: string[] = []): VaultSeeder & { writes: TenantAppKeySeedInput[] } {
  const writes: TenantAppKeySeedInput[] = [];
  return {
    writes,
    seedTenantAppKey: async (input: TenantAppKeySeedInput) => {
      if (failFor.includes(input.guid)) throw new Error("vault tenant app key seed put failed (403)");
      writes.push(input);
      return { created: !standing.includes(`${input.guid}/${input.app}`) };
    },
  } as unknown as VaultSeeder & { writes: TenantAppKeySeedInput[] };
}

const silent = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as unknown as Logger;

describe("a tenant app's Password field key", () => {
  it("is 32 random bytes as base64 under its one property, in one entry per app", async () => {
    const seeder = recordingSeeder();
    await seedTenantAppKeys(seeder, "prod", "g1", ["erp", "jobs"]);
    expect(seeder.writes.map((w) => [w.stage, w.guid, w.app, Object.keys(w.data)])).toEqual([
      ["prod", "g1", "erp", [TENANT_APP_KEY_PROPERTY]],
      ["prod", "g1", "jobs", [TENANT_APP_KEY_PROPERTY]],
    ]);
    for (const w of seeder.writes) expect(Buffer.from(w.data[TENANT_APP_KEY_PROPERTY]!, "base64")).toHaveLength(32);
  });

  it("PLANTED DEFECT: is never shared, between two apps or between two tenants", async () => {
    const seeder = recordingSeeder();
    await seedTenantAppKeys(seeder, "prod", "g1", ["erp", "jobs"]);
    await seedTenantAppKeys(seeder, "prod", "g2", ["erp"]);
    const keys = seeder.writes.map((w) => w.data[TENANT_APP_KEY_PROPERTY]);
    expect(new Set(keys).size).toBe(3);
  });

  it("names the apps whose key already stood apart from the ones it wrote", async () => {
    const outcome = await seedTenantAppKeys(recordingSeeder(["g1/erp"]), "prod", "g1", ["erp", "jobs"]);
    expect(outcome).toEqual({ created: ["jobs"], existing: ["erp"] });
  });
});

describe("the step that keys an app joining a standing tenant", () => {
  const ctx = (logs: string[]): StepCtx => ({ log: (_s: string, t: string) => logs.push(t), checkpoint: () => {} }) as unknown as StepCtx;

  it("writes the key of the one app it is given", async () => {
    const seeder = recordingSeeder();
    const logs: string[] = [];
    await seedPasswordFieldKeyStep(seeder, "prod", "g1", "crm").run(ctx(logs));
    expect(seeder.writes.map((w) => w.app)).toEqual(["crm"]);
    expect(logs.join("\n")).toContain("written for crm");
  });

  it("refuses by name where no seeder is wired", async () => {
    await expect(seedPasswordFieldKeyStep(undefined, "prod", "g1", "crm").run(ctx([]))).rejects.toThrow(/no Vault seeder is wired/);
  });
});

describe("the boot pass over every tenant app", () => {
  let db: DbHandle;
  beforeEach(() => {
    db = openDb(":memory:");
    db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", name: "s1", status: "active" }).run();
    const tenant = (id: string, guid: string, status: "active" | "offboarded") =>
      db.db.insert(tenants).values({ id, clusterId: "cls_1", guid, subdomain: id, stage: "prod", members: ["auth"], identityProvider: "auth", status }).run();
    tenant("tnt_a", "ga", "active");
    tenant("tnt_b", "gb", "active");
    tenant("tnt_c", "gc", "offboarded");
    db.db.insert(tenantApps).values([
      { id: "tna_1", tenantId: "tnt_a", name: "erp" },
      { id: "tna_2", tenantId: "tnt_a", name: "jobs", status: "purged" },
      { id: "tna_3", tenantId: "tnt_b", name: "erp" },
      { id: "tna_4", tenantId: "tnt_c", name: "erp" },
    ]).run();
  });

  it("keys every app of every tenant that is not gone, and counts what already stood", async () => {
    const seeder = recordingSeeder(["gb/erp"]);
    const result = await ensureTenantAppKeys({ db: db.db, seeder, logger: silent });
    expect(seeder.writes.map((w) => `${w.guid}/${w.app}`).sort()).toEqual(["ga/erp", "gb/erp"]);
    expect(result).toEqual({ created: 1, existing: 1, failed: [] });
  });

  it("goes on past a tenant whose write fails, and names it", async () => {
    const seeder = recordingSeeder([], ["ga"]);
    const result = await ensureTenantAppKeys({ db: db.db, seeder, logger: silent });
    expect(result.failed).toEqual(["prod/ga"]);
    expect(seeder.writes.map((w) => w.guid)).toEqual(["gb"]);
  });
});
