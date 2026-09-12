import { describe, expect, it } from "vitest";
import { consumerUnitHost, HOST_LABEL_RE, RESERVED_HOST_LABELS, stageApex, tenantMemberHost, tenantWildcardHost, tenantZone } from "./unit-host.ts";
import { ConsumerManifestSchema, consumerHostLabel, hostLabel } from "./consumer.ts";

/** THE ONE composition of a unit's public host (simetrixch/hostyour-cloud#208): the stage is a
 *  zone and prod is the apex itself, for consumers and tenants alike. */
describe("stage apex — the zone of one stage", () => {
  it("is the unit apex itself for prod, and <stage>.<apex> for the other two", () => {
    expect(stageApex("digitacloud.app", "prod")).toBe("digitacloud.app");
    expect(stageApex("digitacloud.app", "dev")).toBe("dev.digitacloud.app");
    expect(stageApex("digitacloud.app", "test")).toBe("test.digitacloud.app");
  });
});

describe("a consumer's host — <label>.<stage apex>", () => {
  it("carries the label and no stage suffix, prod short", () => {
    expect(consumerUnitHost("auth", "prod", "digitacloud.app")).toBe("auth.digitacloud.app");
    expect(consumerUnitHost("auth", "dev", "digitacloud.app")).toBe("auth.dev.digitacloud.app");
  });

  it("composes from the LABEL, never the unit name — the name stays the identity", () => {
    // digita-auth is the unit; auth is what a person types.
    expect(consumerUnitHost("auth", "prod", "digitacloud.app")).not.toContain("digita-auth");
  });
});

describe("a tenant's zone and members — <member>.<subdomain>.<stage apex>", () => {
  it("puts the tenant one level below the stage zone, and every member one level below the tenant", () => {
    expect(tenantZone("simetrix", "prod", "digitacloud.app")).toBe("simetrix.digitacloud.app");
    expect(tenantZone("simetrix", "dev", "digitacloud.app")).toBe("simetrix.dev.digitacloud.app");
    expect(tenantMemberHost("auth", "prod", "simetrix", "digitacloud.app")).toBe("auth.simetrix.digitacloud.app");
    expect(tenantMemberHost("auth", "dev", "simetrix", "digitacloud.app")).toBe("auth.simetrix.dev.digitacloud.app");
  });

  it("gives every stage its own wildcard, because the zones differ", () => {
    expect(tenantWildcardHost("simetrix", "prod", "digitacloud.app")).toBe("*.simetrix.digitacloud.app");
    expect(tenantWildcardHost("simetrix", "dev", "digitacloud.app")).toBe("*.simetrix.dev.digitacloud.app");
    expect(tenantWildcardHost("simetrix", "dev", "digitacloud.app")).not.toBe(tenantWildcardHost("simetrix", "prod", "digitacloud.app"));
  });
});

describe("the host label", () => {
  it("is one DNS label: lower-case, digits and hyphens, at most 63 characters", () => {
    for (const ok of ["auth", "post", "a", "a-b", "x".repeat(63)]) expect(hostLabel.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["Auth", "auth.dev", "-auth", "auth-", "x".repeat(64), ""]) expect(hostLabel.safeParse(bad).success, bad).toBe(false);
    expect(HOST_LABEL_RE.test("digita-auth")).toBe(true);
  });

  it("refuses the stage words — they are the zones", () => {
    for (const word of RESERVED_HOST_LABELS) {
      const r = hostLabel.safeParse(word);
      expect(r.success, word).toBe(false);
      expect(r.error?.issues[0]?.message).toContain("stage word");
    }
  });

  it("is the manifest's `host`, or the unit's name where it declares none", () => {
    expect(consumerHostLabel({ name: "digita-auth", host: "auth" })).toBe("auth");
    expect(consumerHostLabel({ name: "digita-auth" })).toBe("digita-auth");
    const parsed = ConsumerManifestSchema.parse({
      apiVersion: "hostyour.cloud/v1", kind: "ConsumerManifest", name: "digita-auth", owner: "platform", envs: ["prod"], host: "auth", chart: { path: "deploy/chart" },
    });
    expect(consumerHostLabel(parsed)).toBe("auth");
  });
});
