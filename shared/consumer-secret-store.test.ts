import { describe, it, expect } from "vitest";
import { ConsumerSecretSpecSchema, isOperatorSecret } from "./consumer.ts";

// A secret declared `store` comes from the installation's own store: an entry below the installation's
// stage and one field of it, never also minted, and never asked of the operator.
describe("ConsumerSecretSpecSchema store", () => {
  it("takes an entry path and a field, and refuses one that is also generated or malformed", () => {
    const parsed = ConsumerSecretSpecSchema.parse({ key: "POST_OIDC_CLIENT_SECRET", store: { entry: "idp/clients/post", field: "client-secret" } });
    expect(parsed.store).toEqual({ entry: "idp/clients/post", field: "client-secret" });
    for (const store of [{ entry: "/idp/clients/post", field: "client-secret" }, { entry: "idp/../app", field: "x" }, { entry: "idp/clients/post", field: "a/b" }, { entry: "idp", field: "x", extra: 1 }]) {
      expect(ConsumerSecretSpecSchema.safeParse({ key: "K", store }).success, JSON.stringify(store)).toBe(false);
    }
    expect(ConsumerSecretSpecSchema.safeParse({ key: "K", generate: "hex32", store: { entry: "idp/clients/post", field: "client-secret" } }).success).toBe(false);
  });

  it("asks the operator only for a key that is neither minted nor read from the store", () => {
    expect(isOperatorSecret({})).toBe(true);
    expect(isOperatorSecret({ generate: "hex32" })).toBe(false);
    expect(isOperatorSecret({ store: { entry: "idp/clients/post", field: "client-secret" } })).toBe(false);
  });
});
