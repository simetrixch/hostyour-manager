import { describe, it, expect, afterEach } from "vitest";
import { changeStageIssuer, stageServiceIssuer } from "./tenant-sender-domain-issuer.ts";
import type { TenantCluster } from "./lifecycle.ts";
import type { CredentialStore } from "../../security/store.ts";
import { redact, unregisterScope } from "../../security/redact.ts";
import type { UnitCall } from "#unit/server/adapters/unit-call/port.ts";

// The issuer bound at a sender domain is the one the stage's service tokens carry: the identity
// provider's address on the tenant's zone, never on the tenant's own domain, which is the issuer of
// its sign-ins instead.
describe("stageServiceIssuer", () => {
  it("is the identity provider on the zone, whatever own domain the tenant has", () => {
    const tc = { routing: "path", identityProvider: "auth", stage: "test", subdomain: "simetrix", ownDomain: "show.test.simplidigita.ai" } as TenantCluster;
    expect(stageServiceIssuer(tc, "digitacloud.app")).toBe("https://simetrix.test.digitacloud.app/auth");
    expect(stageServiceIssuer({ ...tc, stage: "prod", ownDomain: "simetrix.ch" }, "digitacloud.app")).toBe("https://simetrix.digitacloud.app/auth");
    expect(stageServiceIssuer({ ...tc, routing: "host", stage: "prod" }, "example.com")).toBe("https://auth.simetrix.example.com");
  });
});

describe("changeStageIssuer", () => {
  afterEach(() => {
    unregisterScope("run_issuer");
  });

  it("masks the opened unit-call key in the run's redactor", async () => {
    const keyMaterial = "k".repeat(64);
    const store = {
      list: async () => [{ id: "cred_1" }],
      open: async () => Buffer.from(keyMaterial, "utf8"),
    };
    const unitCall = {
      call: async () => ({ status: 200, detail: "HTTP 200", body: { added: true } }),
    } as unknown as UnitCall;
    const route = { unit: "post", url: "https://post.{stageApex}/api/sender-domains/{domain}/issuers" };
    await changeStageIssuer(
      { store: store as unknown as Pick<CredentialStore, "list" | "open">, unitCall },
      { route, stage: "prod", unitApex: "example.com", domain: "customer.test", issuer: "https://auth.example.com", change: "add", runId: "run_issuer" },
    );
    expect(redact(`sent with ${keyMaterial}`)).toBe("sent with •••");
  });
});
