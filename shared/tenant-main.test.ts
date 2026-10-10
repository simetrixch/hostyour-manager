import { describe, it, expect } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { appPath, TenantRegistrationSchema, websitePath } from "./tenant.ts";

// `main` on an apps[] entry marks the tenant's main website: a website only, one at most, and never
// written as `main: false`.

const site = (name: string, over: Record<string, unknown> = {}) => ({ name, folder: "web", site: name, ...over });
function parse(apps: { name: string }[]) {
  const members = ["auth", "jobs", "report", ...apps.map((a) => a.name)].map((name) => ({ name, sources: [{ chart: `charts/example-${name}` }] }));
  return TenantRegistrationSchema.safeParse({ members, identityProvider: "auth", cluster: "s1", subdomain: "example", apps, seedUsers: false, quota: seedQuota("small"), resetNonce: "1", suspended: false, quiesced: false });
}
const messages = (r: ReturnType<typeof parse>): string[] => (r.success ? [] : r.error.issues.map((i) => i.message));

describe("main on a tenant registration's apps[]", () => {
  it("keeps `main: true` on one website and gives the other entries no key", () => {
    const r = parse([{ name: "erp" }, site("shop", { main: true }), site("blog")]);
    expect(r.success && r.data.apps.map((a) => a.main)).toEqual([undefined, true, undefined]);
  });

  it("parses `main: false` away, so the writer never serializes it", () => {
    const r = parse([site("shop", { main: false })]);
    expect(r.success).toBe(true);
    expect(r.success && r.data.apps[0]).not.toHaveProperty("main");
  });

  it("refuses two websites marked main, naming both", () => {
    expect(messages(parse([site("shop", { main: true }), site("blog", { main: true })]))).toEqual([expect.stringContaining('more than one app is marked main ("shop", "blog")')]);
  });

  it("refuses `main` on an app that is no website, naming the app", () => {
    expect(messages(parse([{ name: "erp", main: true } as { name: string }]))).toEqual([expect.stringContaining('app "erp" is marked main but is no website')]);
  });
});

describe("the paths of a tenant's host", () => {
  it("serves the main website at /, every other at /web/<site>, and every engine at /app/<app>", () => {
    expect([websitePath({ site: "shop", main: true }), websitePath({ site: "blog" }), appPath("crm")]).toEqual(["/", "/web/blog", "/app/crm"]);
  });
});
