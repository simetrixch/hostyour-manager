import { describe, it, expect } from "vitest";
import { buildCreateTenantBody, type TenantCreateForm } from "./api.ts";

// The create-tenant wizard's only load-bearing pure logic: shaping the form state into the exact
// CreateTenantRequest body the server parses. The trio.report OMISSION (never `report: undefined`)
// is the subtle exactOptionalPropertyTypes rule, and app-row cleanup (trim/blank/dedupe) mirrors
// the server's uniqueness refine — both are asserted here.

const base: TenantCreateForm = {
  clusterId: "cls_abc",
  subdomain: "acme.dev",
  owner: "team-acme",
  apps: [],
  seedUsers: false,
};

describe("buildCreateTenantBody", () => {
  it("trims text fields and defaults an empty apps[] to []", () => {
    const body = buildCreateTenantBody({ ...base, subdomain: "  acme.dev ", owner: " team-acme " });
    expect(body.subdomain).toBe("acme.dev");
    expect(body.owner).toBe("team-acme");
    expect(body.clusterId).toBe("cls_abc");
    expect(body.apps).toEqual([]);
  });

  it("drops blank app rows and de-duplicates by trimmed name (first occurrence wins)", () => {
    const body = buildCreateTenantBody({
      ...base,
      apps: [
        { name: " web ", seedReference: false, seedDemo: false },
        { name: "", seedReference: false, seedDemo: false },
        { name: "web", seedReference: true, seedDemo: true },
        { name: "api", seedReference: false, seedDemo: false },
        { name: "   ", seedReference: false, seedDemo: false },
      ],
    });
    // The first "web" (both tiers false) survives; the later duplicate (both tiers true) is dropped whole.
    expect(body.apps).toEqual([
      { name: "web", seedReference: false, seedDemo: false },
      { name: "api", seedReference: false, seedDemo: false },
    ]);
  });

  it("carries each selected app's per-app seed tiers through to the body", () => {
    const body = buildCreateTenantBody({ ...base, apps: [
      { name: "erp", seedReference: true, seedDemo: false },
      { name: "web", seedReference: false, seedDemo: true },
    ] });
    // Both booleans round-trip independently per app.
    expect(body.apps).toEqual([
      { name: "erp", seedReference: true, seedDemo: false },
      { name: "web", seedReference: false, seedDemo: true },
    ]);
  });

  it("carries seedUsers through, and sends nothing that could select a trio member", () => {
    // auth, jobs and report are members of EVERY tenant, so the body has no field that could turn one
    // off: the only identity-provider choice left is whether it boot-seeds initial accounts.
    expect(buildCreateTenantBody({ ...base, seedUsers: true }).seedUsers).toBe(true);
    const body = buildCreateTenantBody(base);
    expect(body.seedUsers).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["apps", "clusterId", "owner", "seedUsers", "subdomain"]);
  });
});
