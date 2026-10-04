import { describe, expect, it } from "vitest";
import { purgeTenantTitle } from "./PurgeTenantDialog.tsx";

describe("purgeTenantTitle", () => {
  it("names the tenant by subdomain and guid, and the stage and machine it purges", () => {
    expect(purgeTenantTitle({ guid: "ak64h58875qw", subdomain: "simetrix", stage: "test", clusterId: "cls_1", machine: "apps1.digitacloud.app" }))
      .toBe('Purge tenant "simetrix" (ak64h58875qw) · test on apps1.digitacloud.app?');
  });
  it("names an orphan no inventory row knows by its guid alone, never by an empty name", () => {
    expect(purgeTenantTitle({ guid: "k3m9p2q8r4t6", subdomain: "", stage: "test", clusterId: "cls_1", machine: "apps1" }))
      .toBe("Purge tenant k3m9p2q8r4t6 · test on apps1?");
  });
});
