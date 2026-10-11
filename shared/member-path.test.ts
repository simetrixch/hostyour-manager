import { describe, it, expect } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { TenantAppSchema, TenantRegistrationSchema } from "./tenant.ts";
import { TenantSpecSchema, memberPathSchema } from "./consumer.ts";

// The path a member's chart serves on the tenant's host: one grammar for it, the product's manifest
// stating it for a standing member, and one rule deriving it for an app or a website.

describe("memberPathSchema and the member paths of a tenant spec", () => {
  const members = [{ name: "auth", path: "/auth", chart: "charts/example-auth", identityProvider: true }];
  const spec = (over: Record<string, unknown>) => TenantSpecSchema.safeParse({ members, perApp: { engine: { chart: "charts/e" }, front: { chart: "charts/f" } }, ...over });

  it.each(["/", "/auth", "/reports", "/app/workshop", "/web/starter", "/admin/starter"])("accepts %s", (path) => {
    expect(memberPathSchema.safeParse(path).success).toBe(true);
  });

  it.each(["", "auth", "/Auth", "/a//b", "/a/", "//", "/-a", "/a b"])("PLANTED DEFECT: refuses %j", (path) => {
    expect(memberPathSchema.safeParse(path).success).toBe(false);
  });

  it("requires a path on every standing member", () => {
    expect(spec({}).success).toBe(true);
    expect(spec({ members: [{ name: "auth", chart: "charts/example-auth", identityProvider: true }] }).success).toBe(false);
  });

  it("carries the names the product's engine reserves, none where it states none, and refuses a name outside the member grammar", () => {
    expect(spec({ reservedMemberNames: ["api", "ws"] }).data?.reservedMemberNames).toEqual(["api", "ws"]);
    expect(spec({}).data?.reservedMemberNames).toEqual([]);
    expect(spec({ reservedMemberNames: ["Api"] }).success).toBe(false);
  });
});

describe("the paths an apps[] entry carries", () => {
  it("gives an app /app/<name> and a website its admin at /admin/<name> and its site at / (main) or /web/<site>, and keeps the needs it names", () => {
    const workshop = TenantAppSchema.parse({ name: "workshop", needs: ["report"] });
    expect(workshop).toEqual({ name: "workshop", seedReference: false, seedDemo: false, selections: {}, needs: ["report"], path: "/app/workshop" });
    expect(workshop).not.toHaveProperty("sitePath");
    expect(TenantAppSchema.parse({ name: "starter", folder: "web", site: "starter", main: true })).toMatchObject({ path: "/admin/starter", sitePath: "/" });
    expect(TenantAppSchema.parse({ name: "starter", folder: "web", site: "starter" })).toMatchObject({ path: "/admin/starter", sitePath: "/web/starter" });
  });

  it("PLANTED DEFECT: a path or a site path standing in the input is dropped, and the rule's own comes out", () => {
    const sources = [{ chart: "charts/a" }];
    const parsed = TenantRegistrationSchema.parse({
      cluster: "s1", subdomain: "example", identityProvider: "auth", quota: seedQuota("small"),
      members: [{ name: "auth", path: "/auth", sources }, { name: "workshop", path: "/app/workshop", sources }],
      apps: [{ name: "workshop", path: "/apps/workshop", sitePath: "/elsewhere" }],
    });
    expect(parsed.apps[0]).toMatchObject({ path: "/app/workshop" });
    expect(parsed.apps[0]).not.toHaveProperty("sitePath");
  });

  it("refuses a member record without a path, and one whose path is no path", () => {
    const record = (path: unknown) => TenantRegistrationSchema.safeParse({
      cluster: "s1", subdomain: "example", identityProvider: "auth", quota: seedQuota("small"),
      members: [{ name: "auth", ...(path === undefined ? {} : { path }), sources: [{ chart: "charts/a" }] }],
    }).success;
    expect([record("/auth"), record(undefined), record("auth")]).toEqual([true, false, false]);
  });
});
