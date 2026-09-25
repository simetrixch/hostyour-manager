import { describe, it, expect } from "vitest";
import { tenantAppRows, undeployedApps } from "./tenantAppRows.ts";
import type { TenantCatalogAppView } from "../../shared/apps-manifest.ts";

// The tenant page's Apps list: the bundle's apps folded with the inventory's rows. Pure, so it is
// tested here rather than through the page — the factoring tenantRows.test.ts describes.

const entry = (name: string, deployed: boolean): TenantCatalogAppView => ({ name, title: name.toUpperCase(), description: "", selections: {}, deployed });
const row = (name: string, status = "active") => ({ id: `tna_${name}`, name, status, lastRunId: null });

describe("tenantAppRows", () => {
  it("lists the bundle's apps in catalog order, each with its inventory row where a run recorded one", () => {
    const rows = tenantAppRows([entry("erp", true), entry("crm", false)], [row("erp")]);
    expect(rows.map((r) => [r.name, r.deployed, r.row?.id ?? null, r.entry?.title ?? null])).toEqual([
      ["erp", true, "tna_erp", "ERP"],
      ["crm", false, null, "CRM"],
    ]);
  });

  it("keeps an inventory row the bundle no longer names, after the catalog, as deployed — a recorded app never vanishes", () => {
    const rows = tenantAppRows([entry("erp", true)], [row("old", "offboarded"), row("erp")]);
    expect(rows.map((r) => [r.name, r.deployed, r.entry])).toEqual([["erp", true, expect.objectContaining({ name: "erp" })], ["old", true, null]]);
  });

  it("shows every inventory row while the catalog is empty (unreadable, or a tenant without a bundle)", () => {
    expect(tenantAppRows([], [row("erp")]).map((r) => [r.name, r.deployed, r.entry])).toEqual([["erp", true, null]]);
  });
});

describe("undeployedApps", () => {
  it("offers only the bundle's undeployed apps, in catalog order", () => {
    expect(undeployedApps([entry("erp", true), entry("crm", false), entry("web", false)]).map((a) => a.name)).toEqual(["crm", "web"]);
  });
});
