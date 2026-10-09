import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import type { TenantAppCatalogView } from "../../../shared/apps-manifest.ts";
import type { TenantStatus } from "../../../shared/enums.ts";
import { TenantWebsites } from "./TenantWebsites.tsx";

// The Websites section once the tenant's catalog has loaded: a website the tenant removed keeps a row
// here, because the Apps list leaves every website to this section, so this row is the only place its
// purge can be offered.

const catalog: TenantAppCatalogView = {
  apps: [{ name: "web", title: "Web", description: "", selections: {}, deployed: true, sites: ["simetrix-ch", "simplidigita-ai"] }],
  websites: [{ name: "simplidigita-ai", site: "simplidigita-ai", domain: "simplidigita.ai" }],
  members: ["web"],
};
const live = [{ name: "simplidigita-ai", site: "simplidigita-ai", domain: "simplidigita.ai", aliases: [] as string[], main: false }];
const removedSite = (name: string, status: TenantStatus) => ({ name, site: name, status, lastRunId: "run_removed" });

function render(removed: ReturnType<typeof removedSite>[], websites: typeof live = live): string {
  return renderToStaticMarkup(
    createElement(StaticRouter, { location: "/tenants/tnt_1" },
      createElement(TenantWebsites, { tenantId: "tnt_1", catalog, websites, removed, busy: false, act: async () => undefined, onRemove: () => undefined, onPurge: () => undefined, onRecordPackagesReader: async () => undefined })),
  );
}
const rowOf = (html: string, name: string): string => html.split("<li>").find((li) => li.includes(`<span class="row__title">${name}</span>`)) ?? "";
const purges = (html: string): number => html.split(">Purge</button>").length - 1;
const deploys = (html: string): number => html.split(">Deploy</button>").length - 1;

describe("the Websites section on a tenant with a loaded catalog", () => {
  it("offers Purge on a removed website that was offboarded, and on no other row", () => {
    const html = render([removedSite("simetrix-ch", "offboarded")]);
    expect(rowOf(html, "simetrix-ch")).toContain(">Purge</button>");
    expect(rowOf(html, "simplidigita-ai")).not.toContain("Purge");
    expect(purges(html)).toBe(1);
  });

  it("offers no Purge on a removed website that is purged already", () => {
    const html = render([removedSite("digitaplatform-com", "purged")]);
    expect(rowOf(html, "digitaplatform-com")).toContain("removed");
    expect(purges(html)).toBe(0);
  });

  it("offers Purge on the offboarded one of two removed websites only", () => {
    const html = render([removedSite("simetrix-ch", "offboarded"), removedSite("digitaplatform-com", "purged")]);
    expect(rowOf(html, "simetrix-ch")).toContain(">Purge</button>");
    expect(rowOf(html, "digitaplatform-com")).not.toContain("Purge");
  });
});

describe("the Websites section offers Deploy on a site of the bundle that is not deployed", () => {
  it("lists the site as an in-the-bundle row with Deploy, and no Deploy on the live website or a removed one", () => {
    const html = render([removedSite("digitaplatform-com", "offboarded")]);
    expect(rowOf(html, "simetrix-ch")).toContain("in the bundle");
    expect(rowOf(html, "simetrix-ch")).toContain(">Deploy</button>");
    expect(rowOf(html, "simplidigita-ai")).not.toContain("Deploy");
    expect(rowOf(html, "digitaplatform-com")).not.toContain("Deploy");
    expect(deploys(html)).toBe(1);
  });
});

describe("the Websites section marks the tenant's main website", () => {
  it("PLANTED DEFECT: shows the main chip on the website that holds the mark, and on no other row", () => {
    const html = render([], [{ ...live[0]!, main: true }, { name: "blog", site: "blog", domain: "blog.example.ch", aliases: [], main: false }]);
    expect(rowOf(html, "simplidigita-ai")).toContain('<span class="chip">main</span>');
    expect(rowOf(html, "blog")).not.toContain(">main<");
  });

  it("PLANTED INNOCENT: shows no main chip where no website holds the mark", () => {
    expect(render([])).not.toContain(">main<");
  });
});
