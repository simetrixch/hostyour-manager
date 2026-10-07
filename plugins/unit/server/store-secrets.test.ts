import { describe, it, expect } from "vitest";
import { refuseMissingStoreSecrets, readStoreSecrets } from "./store-secrets.ts";
import type { InstallationStore } from "./adapters/vault/installation-store-port.ts";
import type { ConsumerSecretSpec } from "#core/shared/consumer.ts";
import { VaultError } from "#core/server/adapters/vault/port.ts";

const SPECS: ConsumerSecretSpec[] = [
  { key: "POST_OIDC_CLIENT_SECRET", required: true, store: { entry: "idp/clients/post", field: "client-secret" } },
  { key: "SMTP_PASSWORD", required: true },
];
const store = (read: InstallationStore["readField"]): InstallationStore => ({ stage: "prod", readField: read });

describe("store-secrets", () => {
  it("reads nothing for a manifest without store keys, even without a store", async () => {
    expect(await refuseMissingStoreSecrets(undefined, [SPECS[1]!])).toBeNull();
    expect(await readStoreSecrets(undefined, [SPECS[1]!])).toEqual({ values: {}, read: [] });
  });

  it("passes the plan and hands the seed the value where the entry holds it", async () => {
    const holding = store(async () => "s3cr3t");
    expect(await refuseMissingStoreSecrets(holding, SPECS)).toBeNull();
    expect(await readStoreSecrets(holding, SPECS)).toEqual({ values: { POST_OIDC_CLIENT_SECRET: "s3cr3t" }, read: ["POST_OIDC_CLIENT_SECRET from secret/prod/idp/clients/post (field client-secret)"] });
  });

  it("refuses the plan with the reason where the store refuses the read, never taking it for absent", async () => {
    const refusing = store(async () => {
      throw new VaultError('the Manager may not read secret/prod/idp/clients/post: the installation\'s Vault policy "manager" grants it no read there', 403);
    });
    expect(await refuseMissingStoreSecrets(refusing, SPECS)).toMatch(/grants it no read there/);
    await expect(readStoreSecrets(refusing, SPECS)).rejects.toThrow(/grants it no read there/);
  });

  it("lets a Vault that does not answer fail the plan as an error, not as a refusal of the request", async () => {
    const unreachable = store(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(refuseMissingStoreSecrets(unreachable, SPECS)).rejects.toThrow(/fetch failed/);
    const failing = store(async () => {
      throw new VaultError("vault kubernetes login failed (500)", 500);
    });
    await expect(refuseMissingStoreSecrets(failing, SPECS)).rejects.toThrow(/login failed/);
  });
});
