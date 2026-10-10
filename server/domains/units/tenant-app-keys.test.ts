import { describe, it, expect } from "vitest";
import type { StepCtx } from "../../executor/types.ts";
import type { TenantAppKeySeedInput, VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import { seedTenantAppKeyStep, seedTenantAppKeys, seedTenantWebsiteKeys } from "./tenant-app-keys.ts";

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

  it("a revalidate secret is 32 random bytes as base64 under its own kind and property", async () => {
    const seeder = recordingSeeder();
    await seedTenantAppKeys(seeder, "revalidate-secret", "prod", "g1", ["web"]);
    expect(seeder.writes.map((w) => [w.kind, w.app, Object.keys(w.data)])).toEqual([["revalidate-secret", "web", ["revalidate-secret"]]]);
    expect(Buffer.from(seeder.writes[0]!.data["revalidate-secret"]!, "base64")).toHaveLength(32);
  });

  it("PLANTED DEFECT: gives a tenant with two websites one revalidate secret and one form signing key, under web", async () => {
    const seeder = recordingSeeder();
    await seedTenantWebsiteKeys(seeder, "prod", "g1", [{}, { site: "main" }, { site: "shop" }], { log: () => undefined });
    expect(seeder.writes.map((w) => `${w.kind}/${w.app}`)).toEqual(["revalidate-secret/web", "form-signing-key/web"]);
  });

  it("PLANTED INNOCENT: gives a tenant without a website no website key", async () => {
    const seeder = recordingSeeder();
    await seedTenantWebsiteKeys(seeder, "prod", "g1", [{}, {}], { log: () => undefined });
    expect(seeder.writes).toEqual([]);
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

  it("writes the tenant's revalidate secret under its own step, held by web", async () => {
    const seeder = recordingSeeder();
    const logs: string[] = [];
    const step = seedTenantAppKeyStep(seeder, "revalidate-secret", "prod", "g1", "web");
    await step.run(ctx(logs));
    expect(step.name).toBe("seed-revalidate-secret");
    expect(seeder.writes.map((w) => [w.kind, w.app])).toEqual([["revalidate-secret", "web"]]);
    expect(logs.join("\n")).toContain("Revalidate secrets under prod/tenants/g1/revalidate-secret/: written for web");
  });

  it("writes the tenant's form signing key under its own step, held by web, as 32 random bytes under its own property", async () => {
    const seeder = recordingSeeder();
    const logs: string[] = [];
    const step = seedTenantAppKeyStep(seeder, "form-signing-key", "prod", "g1", "web");
    await step.run(ctx(logs));
    expect(step.name).toBe("seed-form-signing-key");
    expect(seeder.writes.map((w) => [w.kind, w.app, Object.keys(w.data)])).toEqual([["form-signing-key", "web", ["form-signing-key"]]]);
    expect(Buffer.from(seeder.writes[0]!.data["form-signing-key"]!, "base64")).toHaveLength(32);
    expect(logs.join("\n")).toContain("Form signing keys under prod/tenants/g1/form-signing-key/: written for web");
  });

  it("writes an app's service key under its own step, as 32 random bytes under its own property, website or not", async () => {
    const seeder = recordingSeeder();
    const logs: string[] = [];
    const step = seedTenantAppKeyStep(seeder, "service-key", "prod", "g1", "crm");
    await step.run(ctx(logs));
    expect(step.name).toBe("seed-service-key");
    expect(seeder.writes.map((w) => [w.kind, w.app, Object.keys(w.data)])).toEqual([["service-key", "crm", ["service-key"]]]);
    expect(Buffer.from(seeder.writes[0]!.data["service-key"]!, "base64")).toHaveLength(32);
    expect(logs.join("\n")).toContain("Service keys under prod/tenants/g1/service-key/: written for crm");
  });

  it("never logs a key it writes", async () => {
    const said: string[] = [];
    const seeder = recordingSeeder();
    const step = seedTenantAppKeyStep(seeder, "form-signing-key", "prod", "gb", "web");
    await step.run({ checkpoint: (data: unknown) => said.push(JSON.stringify(data)), log: (_stream: string, text: string) => said.push(text) } as unknown as StepCtx);
    const keys = seeder.writes.flatMap((w) => Object.values(w.data)).filter((value) => value !== "");
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(said.join("\n")).not.toContain(key);
  });

  it("refuses by name where no seeder is wired", async () => {
    await expect(seedTenantAppKeyStep(undefined, "password-field-key", "prod", "g1", "crm").run(ctx([]))).rejects.toThrow(/no Vault seeder is wired/);
  });
});
