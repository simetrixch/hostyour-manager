import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vault, startVault, stopVault, withSelf } from "./vault-self-seeder.fixture.ts";

beforeEach(startVault);
afterEach(stopVault);

describe("VaultSelfSeeder tenant app keys (hostyour-manager#329)", () => {
  const keyInput = { stage: "prod" as const, guid: "g1", app: "erp", data: { "password-field-key": "a2V5" } };

  it("writes one app's key create-only into its own entry below the tenant's", async () => {
    await withSelf(async (seeder) => {
      expect(await seeder.seedTenantAppKey(keyInput)).toEqual({ created: true });
      expect(vault.recorded.map((r) => `${r.method} ${r.url}`)).toContain("POST /v1/secret/data/prod/tenants/g1/password-field-key/erp");
      const put = vault.recorded.find((r) => r.url === "/v1/secret/data/prod/tenants/g1/password-field-key/erp");
      expect(put!.body).toEqual({ data: { "password-field-key": "a2V5" }, options: { cas: 0 } });
    });
  });

  it("leaves a standing key untouched (created:false), and fails closed on a 403", async () => {
    vault.dataPut = { status: 400, body: JSON.stringify({ errors: ["check-and-set parameter did not match the current version"] }) };
    await withSelf(async (seeder) => expect(await seeder.seedTenantAppKey(keyInput)).toEqual({ created: false }));
    vault.dataPut = { status: 403, body: "permission denied" };
    await withSelf(async (seeder) => expect(seeder.seedTenantAppKey(keyInput)).rejects.toThrow(/tenant app key seed put failed/));
  });

  it("PLANTED DEFECT: refuses an app name that would reach another path, before any request", async () => {
    await withSelf(async (seeder) => {
      await expect(seeder.seedTenantAppKey({ ...keyInput, app: "erp/../../other" })).rejects.toThrow(/is no tenant app name/);
      expect(vault.recorded).toEqual([]);
    });
  });

  it("purges every key it lists under the tenant, including an app the manager no longer knows", async () => {
    vault.metaList = { status: 200, body: JSON.stringify({ data: { keys: ["erp", "retired"] } }) };
    await withSelf(async (seeder) => {
      expect(await seeder.deleteTenantAppKeys({ stage: "prod", guid: "g1" })).toEqual({ deleted: ["erp", "retired"] });
      expect(vault.recorded.filter((r) => r.method === "DELETE").map((r) => r.url)).toEqual([
        "/v1/secret/metadata/prod/tenants/g1/password-field-key/erp",
        "/v1/secret/metadata/prod/tenants/g1/password-field-key/retired",
      ]);
    });
  });

  it("purges nothing, and says so, where no key stands", async () => {
    await withSelf(async (seeder) => expect(await seeder.deleteTenantAppKeys({ stage: "prod", guid: "g1" })).toEqual({ deleted: [] }));
  });
});
