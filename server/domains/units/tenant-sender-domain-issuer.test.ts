import { describe, it, expect } from "vitest";
import { stageServiceIssuer } from "./tenant-sender-domain-issuer.ts";
import type { TenantCluster } from "./lifecycle.ts";

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
