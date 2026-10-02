import { describe, it, expect } from "vitest";
import { listedWebsites, unknownDomainText, newWebsiteName, removedWebsites, tenantAppRows, undeployedApps, websiteFolder } from "./tenantAppRows.ts";
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
  it("keeps a deployed app named after the website folder, which is no website of its own", () => {
    const web = { ...entry("web", true), sites: ["main"] };
    expect(tenantAppRows([entry("erp", true), web], [row("erp"), row("web")], []).map((r) => r.name)).toEqual(["erp", "web"]);
  });

  it("leaves the website folder and the websites to the Websites section", () => {
    const web = { ...entry("web", false), sites: ["main"] };
    const rows = tenantAppRows([entry("erp", true), web], [row("erp"), row("example-ch")], [{ name: "example-ch" }]);
    expect(rows.map((r) => r.name)).toEqual(["erp"]);
    expect(undeployedApps([entry("crm", false), web]).map((a) => a.name)).toEqual(["crm"]);
    expect(websiteFolder([entry("erp", true), web])?.name).toBe("web");
  });

  it("names a new website after its site, clear of the tenant's members and of the apps its catalog offers", () => {
    const catalog = { apps: [entry("workshop", false), { ...entry("web", false), sites: ["veloluck", "auth"] }], members: ["auth", "jobs", "report", "veloluck"] };
    expect(newWebsiteName(catalog, "show")).toBe("show");
    // A standing member and an earlier website, then an app the tenant has not added yet.
    expect(newWebsiteName(catalog, "auth")).toBe("auth-2");
    expect(newWebsiteName(catalog, "veloluck")).toBe("veloluck-2");
    expect(newWebsiteName(catalog, "workshop")).toBe("workshop-2");
  });

  it("keeps a removed website out of the Apps list and hands it to the Websites section, with its site and last run", () => {
    const removed = { id: "tna_old", name: "veloluck-show-digitapla-a9665c", status: "offboarded", lastRunId: "run_rm", site: "veloluck" };
    const standing = { id: "tna_v", name: "veloluck", status: "active", lastRunId: "run_add", site: "veloluck" };
    const rows = [row("erp"), removed, standing];
    expect(tenantAppRows([entry("erp", true)], rows, [{ name: "veloluck" }]).map((r) => r.name)).toEqual(["erp"]);
    expect(removedWebsites(rows)).toEqual([removed]);
    // A catalog still loading, or one that answered without its websites, never turns a live website into a removed one.
    expect(removedWebsites([standing])).toEqual([]);
  });

  it("lists the catalog's websites with their domains, and every live inventory website the catalog does not name", () => {
    const live = { ...row("veloluck"), site: "veloluck" };
    const unnamed = { ...row("show"), site: "show" };
    const gone = { ...row("old", "offboarded"), site: "old" };
    expect(listedWebsites({ websites: [{ name: "veloluck", site: "veloluck", domain: "veloluck.ch" }] }, [live])).toEqual([{ name: "veloluck", site: "veloluck", domain: "veloluck.ch" }]);
    // A live website the catalog's list leaves out stays on the page, by name and site, without the
    // domain only the registration knows, beside the ones the catalog names.
    expect(listedWebsites({ websites: [{ name: "veloluck", site: "veloluck", domain: "veloluck.ch" }] }, [live, unnamed])).toEqual([{ name: "veloluck", site: "veloluck", domain: "veloluck.ch" }, { name: "show", site: "show", domain: null }]);
    // Loading, unreadable or degraded: the same, and a removed website is never listed as live.
    expect(listedWebsites(null, [row("erp"), live, gone])).toEqual([{ name: "veloluck", site: "veloluck", domain: null }]);
    expect(listedWebsites({}, [live])).toEqual([{ name: "veloluck", site: "veloluck", domain: null }]);
  });

  it("says why a website's domain is unknown only as far as the page knows it", () => {
    expect(unknownDomainText(null)).toBe("domain unknown while the tenant's catalog loads");
    expect(unknownDomainText({ error: "clone failed" })).toBe("domain unknown: the tenant's catalog cannot be read");
    expect(unknownDomainText({ reason: "tenant onboarding is not configured on this manager" })).toBe("domain unknown: the catalog is not read for this tenant");
    expect(unknownDomainText({ websites: [] })).toBe("domain unknown: the tenant's registration names no website of this name");
  });

  it("PLANTED INNOCENT: a removed app names no site and stays under Apps as offboarded", () => {
    const rows = [row("erp"), { ...row("crm", "offboarded"), site: null }];
    expect(tenantAppRows([entry("erp", true)], rows).map((r) => [r.name, r.row?.status])).toEqual([["erp", "active"], ["crm", "offboarded"]]);
    expect(removedWebsites(rows)).toEqual([]);
  });

  it("offers only the bundle's undeployed apps, in catalog order", () => {
    expect(undeployedApps([entry("erp", true), entry("crm", false), entry("web", false)]).map((a) => a.name)).toEqual(["crm", "web"]);
  });
});
