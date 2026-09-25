import { describe, it, expect } from "vitest";
import { buildCreateTenantBody, type TenantCreateForm } from "./api.ts";
import { appSelectionsToRequest } from "../../shared/app-selections.ts";

// The create-tenant wizard's only load-bearing pure logic: shaping the form state into the exact
// CreateTenantRequest body the server parses. The trio.report OMISSION (never `report: undefined`)
// is the subtle exactOptionalPropertyTypes rule, and app-row cleanup (trim/blank/dedupe) mirrors
// the server's uniqueness refine — both are asserted here. appSelectionsToRequest is the wizard's
// other pure step: one app's checked selections into the entry shape.

const base: TenantCreateForm = {
  clusterId: "cls_abc",
  stage: "prod",
  subdomain: "acme",
  owner: "team-acme",
  size: "small",
  apps: [],
  seedUsers: false,
};

describe("buildCreateTenantBody", () => {
  it("trims text fields and defaults an empty apps[] to []", () => {
    const body = buildCreateTenantBody({ ...base, subdomain: "  acme ", owner: " team-acme " });
    expect(body.subdomain).toBe("acme");
    expect(body.owner).toBe("team-acme");
    expect(body.clusterId).toBe("cls_abc");
    expect(body.apps).toEqual([]);
  });

  it("drops blank app rows and de-duplicates by trimmed name (first occurrence wins)", () => {
    const body = buildCreateTenantBody({
      ...base,
      apps: [
        { name: " web ", seedReference: false, seedDemo: false, selections: {} },
        { name: "", seedReference: false, seedDemo: false, selections: {} },
        { name: "web", seedReference: true, seedDemo: true, selections: {} },
        { name: "api", seedReference: false, seedDemo: false, selections: {} },
        { name: "   ", seedReference: false, seedDemo: false, selections: {} },
      ],
    });
    // The first "web" (both tiers false) survives; the later duplicate (both tiers true) is dropped whole.
    expect(body.apps).toEqual([
      { name: "web", seedReference: false, seedDemo: false, selections: {} },
      { name: "api", seedReference: false, seedDemo: false, selections: {} },
    ]);
  });

  it("carries each selected app's per-app seed tiers through to the body", () => {
    const body = buildCreateTenantBody({ ...base, apps: [
      { name: "erp", seedReference: true, seedDemo: false, selections: {} },
      { name: "web", seedReference: false, seedDemo: true, selections: {} },
    ] });
    // Both booleans round-trip independently per app.
    expect(body.apps).toEqual([
      { name: "erp", seedReference: true, seedDemo: false, selections: {} },
      { name: "web", seedReference: false, seedDemo: true, selections: {} },
    ]);
  });

  it("carries every further selection under selections, and the two seed selections as fields", () => {
    // What the wizard composes per checked app: the catalog's selections, the two known ones onto
    // their fields, the rest keyed by name — false included, because a key names a selection.
    const entry = appSelectionsToRequest("erp", { seedReference: true, seedDemo: false, seedPrices: true, seedFixtures: false });
    expect(entry).toEqual({ name: "erp", seedReference: true, seedDemo: false, selections: { seedPrices: true, seedFixtures: false } });
    expect(appSelectionsToRequest("web", {})).toEqual({ name: "web", seedReference: false, seedDemo: false, selections: {} });
    const body = buildCreateTenantBody({ ...base, apps: [entry] });
    expect(body.apps).toEqual([entry]);
  });

  it("carries seedUsers through, and sends nothing that could select a trio member", () => {
    // auth, jobs and report are members of EVERY tenant, so the body has no field that could turn one
    // off: the only identity-provider choice left is whether it boot-seeds initial accounts.
    expect(buildCreateTenantBody({ ...base, seedUsers: true }).seedUsers).toBe(true);
    const body = buildCreateTenantBody(base);
    expect(body.seedUsers).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["apps", "clusterId", "owner", "seedUsers", "size", "stage", "subdomain"]);
  });

  it("sends the size the operator picked — the run used to take the default whatever the wizard showed", () => {
    expect(buildCreateTenantBody({ ...base, size: "large" }).size).toBe("large");
  });
});
