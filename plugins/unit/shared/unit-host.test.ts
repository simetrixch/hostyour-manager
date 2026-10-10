import { describe, expect, it } from "vitest";
import { consumerUnitHost, HOST_LABEL_RE, RESERVED_HOST_LABELS, stageApex, tenantIssuerRecord, tenantMemberUrl, tenantZone, ownDomainEntryProblem, ownDomainHosts, stageHost, prodHostOf, stageHostProblem } from "./unit-host.ts";
import { ConsumerManifestSchema, consumerHostLabel, hostLabel } from "#core/shared/consumer.ts";

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

describe("a tenant's zone and members — <subdomain>.<stage apex>/<member>", () => {
  it("puts the tenant one level below the stage zone, and every member one level below the tenant", () => {
    expect(tenantZone("example", "prod", "digitacloud.app")).toBe("example.digitacloud.app");
    expect(tenantZone("example", "dev", "digitacloud.app")).toBe("example.dev.digitacloud.app");
  });

  it("addresses a member under a path of the zone", () => {
    expect(tenantMemberUrl("idp", "prod", "acme", "example.test", "")).toBe("https://acme.example.test/idp");
    expect(tenantMemberUrl("idp", "dev", "acme", "example.test", "")).toBe("https://acme.dev.example.test/idp");
  });

  it("addresses a member under a path of the tenant's own domain where it has one, instead of its zone", () => {
    expect(tenantMemberUrl("idp", "prod", "acme", "example.test", "www.customer.example")).toBe("https://www.customer.example/idp");
    expect(tenantMemberUrl("idp", "dev", "acme", "example.test", "customer.example")).toBe("https://customer.example/idp");
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

  it("refuses the platform's own hosts — units stand directly under the apex beside them", () => {
    for (const word of ["www", "show", "mail", "autodiscover", "master", "master1", "apps", "apps3", "appstore", "srv1", "enterprise", "enterpriseregistration"]) {
      const r = hostLabel.safeParse(word);
      expect(r.success, word).toBe(false);
      expect(r.error?.issues[0]?.message, word).toContain("platform host");
    }
    for (const ok of ["post", "swissbookai", "example", "shop", "mailer-x", "my-apps", "wwwx"]) expect(hostLabel.safeParse(ok).success, ok).toBe(true);
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

describe("a tenant's own domain — typed without www, served at the apex", () => {
  it("PLANTED DEFECT: serves the typed domain itself and redirects www.<domain> there", () => {
    expect(ownDomainHosts("example.org")).toEqual({ ownDomain: "example.org", ownDomainRedirects: ["www.example.org"] });
    expect(ownDomainHosts("")).toEqual({ ownDomain: "", ownDomainRedirects: [] });
  });

  it("refuses an entry typed with www, naming the address it would be served at", () => {
    expect(ownDomainEntryProblem("www.example.org")).toBe('type the domain without "www." (example.org); it is served at example.org, and www.example.org redirects there');
    expect(ownDomainEntryProblem("example.org")).toBeNull();
  });
});

describe("a tenant identity provider's DNS mark — the issuer under the zone", () => {
  it("names the record under the zone and holds the identity provider's address on it", () => {
    expect(tenantIssuerRecord("_digita-idp", "auth", "prod", "show", "digitacloud.app")).toEqual({ name: "_digita-idp.show.digitacloud.app", content: "https://show.digitacloud.app/auth" });
    expect(tenantIssuerRecord("_digita-idp", "auth", "dev", "show", "digitacloud.app")).toEqual({ name: "_digita-idp.show.dev.digitacloud.app", content: "https://show.dev.digitacloud.app/auth" });
  });

  it("PLANTED DEFECT: never names the own domain, whose DNS the customer controls", () => {
    const mark = tenantIssuerRecord("_idp", "auth", "prod", "show", "digitacloud.app");
    expect(mark.content).toBe(tenantMemberUrl("auth", "prod", "show", "digitacloud.app", ""));
    expect(mark.content).not.toBe(tenantMemberUrl("auth", "prod", "show", "digitacloud.app", "show.example.org"));
  });
});

describe("a stage host — the stage stands directly before the zone that holds the host", () => {
  it("composes a dev or test host as <labels below the zone>.<stage>.<zone>, and keeps a prod host as it is", () => {
    expect(stageHost("show.example.org", "example.org", "test")).toBe("show.test.example.org");
    expect(stageHost("cycleshop.show.example.org", "example.org", "test")).toBe("cycleshop.show.test.example.org");
    expect(stageHost("example.org", "example.org", "dev")).toBe("dev.example.org");
    expect(stageHost("show.example.co.uk", "example.co.uk", "test")).toBe("show.test.example.co.uk");
    expect(stageHost("show.example.org", "example.org", "prod")).toBe("show.example.org");
  });

  it("reads the prod host back off a stage host, and nothing off a host without the stage before the zone", () => {
    expect(prodHostOf("cycleshop.show.test.example.org", "example.org", "test")).toBe("cycleshop.show.example.org");
    expect(prodHostOf("test.example.org", "example.org", "test")).toBe("example.org");
    expect(prodHostOf("test.show.example.org", "example.org", "test")).toBeNull();
    expect(prodHostOf("show.example.org", "example.org", "prod")).toBe("show.example.org");
  });

  it("PLANTED DEFECT: refuses a test host with the stage in front of the whole name, naming the host it is", () => {
    expect(stageHostProblem("test.show.example.org", "example.org", "test")).toBe("test.show.example.org is no test host: the stage stands directly before the zone example.org, so it is show.test.example.org");
    expect(stageHostProblem("test.cycleshop.show.example.org", "example.org", "test")).toMatch(/so it is cycleshop\.show\.test\.example\.org$/);
    expect(stageHostProblem("show.example.org", "example.org", "test")).toMatch(/so it is show\.test\.example\.org$/);
    expect(stageHostProblem("show.test.example.org", "example.org", "dev")).toMatch(/is no dev host: .* so it is show\.dev\.example\.org$/);
  });

  it("PLANTED DEFECT: refuses a prod host with a stage label before its zone, naming the prod host", () => {
    expect(stageHostProblem("show.test.example.org", "example.org", "prod")).toBe("show.test.example.org carries the stage test before its zone example.org, and prod carries none: it is show.example.org");
  });

  it("PLANTED INNOCENT: passes a host that keeps the rule at its stage", () => {
    expect(stageHostProblem("show.test.example.org", "example.org", "test")).toBeNull();
    expect(stageHostProblem("test.example.org", "example.org", "test")).toBeNull();
    expect(stageHostProblem("cycleshop.show.dev.example.org", "example.org", "dev")).toBeNull();
    expect(stageHostProblem("show.example.org", "example.org", "prod")).toBeNull();
    expect(stageHostProblem("example.org", "example.org", "prod")).toBeNull();
  });
});
