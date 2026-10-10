import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PurgeTenantDialog, purgeTenantTitle } from "./PurgeTenantDialog.tsx";

describe("purgeTenantTitle", () => {
  it("names the tenant by subdomain and guid, and the stage and machine it purges", () => {
    expect(purgeTenantTitle({ guid: "ak64h58875qw", subdomain: "example", stage: "test", clusterId: "cls_1", machine: "apps1.digitacloud.app" }))
      .toBe('Purge tenant "example" (ak64h58875qw) · test on apps1.digitacloud.app?');
  });
  it("names an orphan no inventory row knows by its guid alone, never by an empty name", () => {
    expect(purgeTenantTitle({ guid: "k3m9p2q8r4t6", subdomain: "", stage: "test", clusterId: "cls_1", machine: "apps1" }))
      .toBe("Purge tenant k3m9p2q8r4t6 · test on apps1?");
  });
});

describe("PurgeTenantDialog on PROD", () => {
  it("cannot be confirmed without typing the guid and the environment", () => {
    const html = renderToStaticMarkup(createElement(PurgeTenantDialog, {
      target: { guid: "ak64h58875qw", subdomain: "example", stage: "prod", clusterId: "cls_2", machine: "apps2.digitacloud.app" },
      onConfirm: () => undefined, onCancel: () => undefined,
    }));
    expect(html).toContain('Type <span class="mono">ak64h58875qw prod</span> to confirm');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Plan purge<\/button>/);
  });
});
