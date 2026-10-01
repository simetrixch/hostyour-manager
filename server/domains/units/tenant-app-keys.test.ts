import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TenantAppKeySeedInput, VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import { ensureTenantAppKeys, seedTenantAppKeyStep, seedTenantAppKeys } from "./tenant-app-keys.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";

// Every tenant app's Password field key, and every tenant website's revalidate secret and form
// signing key: one per app and kind, 32 random bytes as base64, written create-only into the app's own
// entry below the tenant's.

/** A seeder that remembers every key it was handed, answers "exists" for the apps in [standing] (a
 *  guid and app for every kind, or a guid, kind and app for one), and fails for a guid, or a guid and
 *  kind, in [failFor]. */
function recordingSeeder(standing: string[] = [], failFor: string[] = []): VaultSeeder & { writes: TenantAppKeySeedInput[] } {
  const writes: TenantAppKeySeedInput[] = [];
  return {
    writes,
    seedTenantAppKey: async (input: TenantAppKeySeedInput) => {
      if (failFor.includes(input.guid) || failFor.includes(`${input.guid}/${input.kind}`)) throw new Error("vault tenant app key seed put failed (403)");
      writes.push(input);
      return { created: !standing.includes(`${input.guid}/${input.app}`) && !standing.includes(`${input.guid}/${input.kind}/${input.app}`) };
    },
  } as unknown as VaultSeeder & { writes: TenantAppKeySeedInput[] };
}

const silent = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as unknown as Logger;

describe("a tenant app's Password field key", () => {
  it("is 32 random bytes as base64 under its one property, in one entry per app", async () => {
    const seeder = recordingSeeder();
    await seedTenantAppKeys(seeder, "password-field-key", "prod", "g1", ["erp", "jobs"]);
    expect(seeder.writes.map((w) => [w.stage, w.guid, w.kind, w.app, Object.keys(w.data)])).toEqual([
      ["prod", "g1", "password-field-key", "erp", ["password-field-key"]],
      ["prod", "g1", "password-field-key", "jobs", ["password-field-key"]],
    ]);
    for (const w of seeder.writes) expect(Buffer.from(w.data["password-field-key"]!, "base64")).toHaveLength(32);
  });

  it("a website's revalidate secret is 32 random bytes as base64 under its own kind and property", async () => {
    const seeder = recordingSeeder();
    await seedTenantAppKeys(seeder, "revalidate-secret", "prod", "g1", ["simetrix-ch"]);
    expect(seeder.writes.map((w) => [w.kind, w.app, Object.keys(w.data)])).toEqual([["revalidate-secret", "simetrix-ch", ["revalidate-secret"]]]);
    expect(Buffer.from(seeder.writes[0]!.data["revalidate-secret"]!, "base64")).toHaveLength(32);
  });

  it("PLANTED DEFECT: is never shared, between two apps or between two tenants", async () => {
    const seeder = recordingSeeder();
    await seedTenantAppKeys(seeder, "password-field-key", "prod", "g1", ["erp", "jobs"]);
    await seedTenantAppKeys(seeder, "password-field-key", "prod", "g2", ["erp"]);
    await seedTenantAppKeys(seeder, "revalidate-secret", "prod", "g1", ["erp"]);
    const keys = seeder.writes.map((w) => Object.values(w.data)[0]);
    expect(new Set(keys).size).toBe(4);
  });

  it("names the apps whose key already stood apart from the ones it wrote", async () => {
    const outcome = await seedTenantAppKeys(recordingSeeder(["g1/erp"]), "password-field-key", "prod", "g1", ["erp", "jobs"]);
    expect(outcome).toEqual({ created: ["jobs"], existing: ["erp"] });
  });
});

describe("the step that keys an app joining a standing tenant", () => {
  const ctx = (logs: string[]): StepCtx => ({ log: (_s: string, t: string) => logs.push(t), checkpoint: () => {} }) as unknown as StepCtx;

  it("writes the key of the one app it is given", async () => {
    const seeder = recordingSeeder();
    const logs: string[] = [];
    const step = seedTenantAppKeyStep(seeder, "password-field-key", "prod", "g1", "crm");
    await step.run(ctx(logs));
    expect(step.name).toBe("seed-password-field-key");
    expect(seeder.writes.map((w) => [w.kind, w.app])).toEqual([["password-field-key", "crm"]]);
    expect(logs.join("\n")).toContain("Password field keys under prod/tenants/g1/password-field-key/: written for crm");
  });

  it("writes a website's revalidate secret under its own step", async () => {
    const seeder = recordingSeeder();
    const logs: string[] = [];
    const step = seedTenantAppKeyStep(seeder, "revalidate-secret", "prod", "g1", "simetrix-ch");
    await step.run(ctx(logs));
    expect(step.name).toBe("seed-revalidate-secret");
    expect(seeder.writes.map((w) => [w.kind, w.app])).toEqual([["revalidate-secret", "simetrix-ch"]]);
    expect(logs.join("\n")).toContain("Revalidate secrets under prod/tenants/g1/revalidate-secret/: written for simetrix-ch");
  });

  it("writes a website's form signing key under its own step, as 32 random bytes under its own property", async () => {
    const seeder = recordingSeeder();
    const logs: string[] = [];
    const step = seedTenantAppKeyStep(seeder, "form-signing-key", "prod", "g1", "simetrix-ch");
    await step.run(ctx(logs));
    expect(step.name).toBe("seed-form-signing-key");
    expect(seeder.writes.map((w) => [w.kind, w.app, Object.keys(w.data)])).toEqual([["form-signing-key", "simetrix-ch", ["form-signing-key"]]]);
    expect(Buffer.from(seeder.writes[0]!.data["form-signing-key"]!, "base64")).toHaveLength(32);
    expect(logs.join("\n")).toContain("Form signing keys under prod/tenants/g1/form-signing-key/: written for simetrix-ch");
  });

  it("refuses by name where no seeder is wired", async () => {
    await expect(seedTenantAppKeyStep(undefined, "password-field-key", "prod", "g1", "crm").run(ctx([]))).rejects.toThrow(/no Vault seeder is wired/);
  });
});

describe("the boot pass over every tenant app", () => {
  let db: DbHandle;
  // What each tenant's registration lists: a website is an entry that names a domain.
  const registered: Record<string, { name: string; folder?: string; site?: string; domain?: string }[]> = {
    ga: [{ name: "erp" }, { name: "jobs", domain: "jobs.example" }], // jobs is purged: no secret
    gb: [{ name: "erp" }, { name: "shop", folder: "web", site: "shop", domain: "shop.example" }],
    gc: [{ name: "site", domain: "gone.example" }], // an offboarded tenant: no secret
  };
  const registrations = (unreadable: string[] = []) => ({
    readTenant: async (_stage: string, guid: string) => {
      if (unreadable.includes(guid)) throw new Error(`tenant registration of ${guid} failed its schema`);
      return { entry: { apps: registered[guid] ?? [] } };
    },
  }) as unknown as Pick<TenantRegistrations, "readTenant">;
  const written = (seeder: { writes: TenantAppKeySeedInput[] }) => seeder.writes.map((w) => `${w.guid}/${w.kind}/${w.app}`).sort();

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
      { id: "tna_5", tenantId: "tnt_b", name: "shop" },
      { id: "tna_6", tenantId: "tnt_c", name: "site" },
    ]).run();
  });

  it("keys every app of every tenant that is not gone, every website among them with its revalidate secret and form signing key, and counts what already stood", async () => {
    const seeder = recordingSeeder(["gb/erp"]);
    const result = await ensureTenantAppKeys({ db: db.db, seeder, registrations: registrations(), logger: silent });
    expect(written(seeder)).toEqual(["ga/password-field-key/erp", "gb/form-signing-key/shop", "gb/password-field-key/erp", "gb/password-field-key/shop", "gb/revalidate-secret/shop"]);
    expect(result).toEqual({ created: 4, existing: 1, failed: [] });
  });

  it("writes a website's form signing key only where none stands, and keeps the one that does", async () => {
    const said: string[] = [];
    const logger = { ...silent, info: (_fields: unknown, line: string) => said.push(line) } as unknown as Logger;
    const result = await ensureTenantAppKeys({ db: db.db, seeder: recordingSeeder(["gb/form-signing-key/shop"]), registrations: registrations(), logger });
    expect(result).toEqual({ created: 4, existing: 1, failed: [] });
    expect(said.some((line) => line.startsWith("Form signing keys under prod/tenants/gb/form-signing-key/"))).toBe(false);
    expect(said.at(-1)).toBe("tenant app keys: 4 written, 1 already standing, 0 failed");
  });

  it("never logs a key it writes, in the boot pass or in add-app's step", async () => {
    const said: string[] = [];
    const record = (...args: unknown[]): void => { said.push(JSON.stringify(args)); };
    const logger = { info: record, error: record, warn: record, debug: record } as unknown as Logger;
    const seeder = recordingSeeder();
    await ensureTenantAppKeys({ db: db.db, seeder, registrations: registrations(), logger });
    const step = seedTenantAppKeyStep(seeder, "form-signing-key", "prod", "gb", "shop");
    await step.run({ checkpoint: (data: unknown) => said.push(JSON.stringify(data)), log: (_stream: string, text: string) => said.push(text) } as unknown as StepCtx);
    const keys = seeder.writes.flatMap((w) => Object.values(w.data));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(said.join("\n")).not.toContain(key);
  });

  it("goes on past a tenant whose write fails, and names it", async () => {
    const seeder = recordingSeeder([], ["ga"]);
    const result = await ensureTenantAppKeys({ db: db.db, seeder, registrations: registrations(), logger: silent });
    expect(result.failed).toEqual(["prod/ga/password-field-key"]);
    expect([...new Set(seeder.writes.map((w) => w.guid))]).toEqual(["gb"]);
  });

  it("PLANTED DEFECT: a form signing key that cannot be written leaves the website's other keys written", async () => {
    const refused = recordingSeeder([], ["gb/form-signing-key"]);
    expect((await ensureTenantAppKeys({ db: db.db, seeder: refused, registrations: registrations(), logger: silent })).failed).toEqual(["prod/gb/form-signing-key"]);
    expect(written(refused)).toEqual(["ga/password-field-key/erp", "gb/password-field-key/erp", "gb/password-field-key/shop", "gb/revalidate-secret/shop"]);
  });

  it("PLANTED DEFECT: a revalidate secret that cannot be written, or a registration that cannot be read, leaves the Password field keys written", async () => {
    const refused = recordingSeeder([], ["gb/revalidate-secret"]);
    expect((await ensureTenantAppKeys({ db: db.db, seeder: refused, registrations: registrations(), logger: silent })).failed).toEqual(["prod/gb/revalidate-secret"]);
    expect(written(refused)).toEqual(["ga/password-field-key/erp", "gb/form-signing-key/shop", "gb/password-field-key/erp", "gb/password-field-key/shop"]);
    const unread = recordingSeeder();
    expect((await ensureTenantAppKeys({ db: db.db, seeder: unread, registrations: registrations(["gb"]), logger: silent })).failed)
      .toEqual(["prod/gb/revalidate-secret", "prod/gb/form-signing-key"]);
    expect(written(unread)).toEqual(["ga/password-field-key/erp", "gb/password-field-key/erp", "gb/password-field-key/shop"]);
  });
});
