import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vault, startVault, stopVault, withSelf } from "./vault-self-seeder.fixture.ts";

beforeEach(startVault);
afterEach(stopVault);

describe("VaultSelfSeeder tenant app keys", () => {
  const keyInput = { stage: "prod" as const, guid: "g1", kind: "password-field-key" as const, app: "erp", data: { "password-field-key": "a2V5" } };

  it("writes one app's key create-only into its own entry below the tenant's", async () => {
    await withSelf(async (seeder) => {
      expect(await seeder.seedTenantAppKey(keyInput)).toEqual({ created: true });
      expect(vault.recorded.map((r) => `${r.method} ${r.url}`)).toContain("POST /v1/secret/data/prod/tenants/g1/password-field-key/erp");
      const put = vault.recorded.find((r) => r.url === "/v1/secret/data/prod/tenants/g1/password-field-key/erp");
      expect(put!.body).toEqual({ data: { "password-field-key": "a2V5" }, options: { cas: 0 } });
    });
  });

  it("writes a website's revalidate secret into its own entry beside the Password field keys", async () => {
    await withSelf(async (seeder) => {
      expect(await seeder.seedTenantAppKey({ ...keyInput, kind: "revalidate-secret", app: "simetrix-ch", data: { "revalidate-secret": "c2Vj" } })).toEqual({ created: true });
      const put = vault.recorded.find((r) => r.method === "POST" && r.url.includes("/data/"));
      expect(put).toMatchObject({ url: "/v1/secret/data/prod/tenants/g1/revalidate-secret/simetrix-ch", body: { data: { "revalidate-secret": "c2Vj" }, options: { cas: 0 } } });
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

  it("purges every key of every kind it lists under the tenant, including an app the manager no longer knows", async () => {
    vault.metaLists["prod/tenants/g1/password-field-key"] = { status: 200, body: JSON.stringify({ data: { keys: ["erp", "retired"] } }) };
    vault.metaLists["prod/tenants/g1/revalidate-secret"] = { status: 200, body: JSON.stringify({ data: { keys: ["simetrix-ch"] } }) };
    await withSelf(async (seeder) => {
      expect(await seeder.deleteTenantAppKeys({ stage: "prod", guid: "g1" })).toEqual({ deleted: ["password-field-key/erp", "password-field-key/retired", "revalidate-secret/simetrix-ch"] });
      expect(vault.recorded.filter((r) => r.method === "DELETE").map((r) => r.url)).toEqual([
        "/v1/secret/metadata/prod/tenants/g1/password-field-key/erp",
        "/v1/secret/metadata/prod/tenants/g1/password-field-key/retired",
        "/v1/secret/metadata/prod/tenants/g1/revalidate-secret/simetrix-ch",
      ]);
    });
  });

  it("purges the revalidate secrets where no Password field key stands, and fails closed on a refused list", async () => {
    vault.metaLists["prod/tenants/g1/revalidate-secret"] = { status: 200, body: JSON.stringify({ data: { keys: ["shop"] } }) };
    await withSelf(async (seeder) => expect(await seeder.deleteTenantAppKeys({ stage: "prod", guid: "g1" })).toEqual({ deleted: ["revalidate-secret/shop"] }));
    vault.metaLists["prod/tenants/g1/revalidate-secret"] = { status: 403, body: "permission denied" };
    await withSelf(async (seeder) => expect(seeder.deleteTenantAppKeys({ stage: "prod", guid: "g1" })).rejects.toThrow(/tenant app key list failed for secret\/prod\/tenants\/g1\/revalidate-secret \(403\)/));
  });

  it("purges nothing, and says so, where no key stands", async () => {
    await withSelf(async (seeder) => expect(await seeder.deleteTenantAppKeys({ stage: "prod", guid: "g1" })).toEqual({ deleted: [] }));
  });
});
