import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vault, startVault, stopVault, withSelfAuth } from "./vault-self-seeder.fixture.ts";
import { VaultInstallationStore } from "./vault-installation-store.ts";
import { VaultError } from "#core/server/adapters/vault/port.ts";

// The one value read the Manager makes outside its own credential store: one field of one entry of
// the installation's store, under the installation's stage, as the Manager itself, token revoked.
beforeEach(startVault);
afterEach(stopVault);

const read = (field = "client-secret") => withSelfAuth((self) => new VaultInstallationStore({ self, stage: "prod" }).readField("idp/clients/post", field));

describe("VaultInstallationStore", () => {
  it("reads the field under the installation's stage as the Manager itself, and revokes the token", async () => {
    vault.dataGet = { status: 200, body: JSON.stringify({ data: { data: { "client-secret": "s3cr3t" } } }) };
    expect(await read()).toBe("s3cr3t");
    expect(vault.recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST /v1/auth/kubernetes/login",
      "GET /v1/secret/data/prod/idp/clients/post",
      "POST /v1/auth/token/revoke-self",
    ]);
    expect(vault.recorded[1]!.token).toBe("s.tok123");
  });

  it("answers null for an entry that does not exist, a field it lacks, and an empty field", async () => {
    expect(await read()).toBeNull();
    vault.dataGet = { status: 200, body: JSON.stringify({ data: { data: { "client-secret": "" , other: "x" } } }) };
    expect(await read()).toBeNull();
    expect(await read("missing")).toBeNull();
  });

  it("names a refused read as the policy's, never as absent, and still revokes the token", async () => {
    vault.dataGet = { status: 403, body: "{}" };
    await expect(read()).rejects.toThrow(VaultError);
    await expect(read()).rejects.toThrow(/may not read secret\/prod\/idp\/clients\/post: the installation's Vault policy "manager" grants it no read there/);
    expect(vault.recorded.filter((r) => r.url === "/v1/auth/token/revoke-self")).toHaveLength(2);
  });

  it("refuses without the Manager's own Vault login", async () => {
    await expect(new VaultInstallationStore({ stage: "prod" }).readField("idp/clients/post", "client-secret")).rejects.toThrow(/no own Vault login/);
  });
});
