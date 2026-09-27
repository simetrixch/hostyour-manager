import { describe, it, expect } from "vitest";
import { seedQuota } from "#unit/shared/unit-size.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import { tenantHeldPins } from "./tenant-pins.ts";

// The registry reaper keeps what a tenant holds: its own version of every build its charts pin,
// however old, and its own apps bundle. A registration it cannot read stops the reaper instead of
// leaving that tenant's images unprotected.

const GUID = "zsjs023ctne0";
const OLD = "0.1.2-stable-20260901120000-def5678";

function books(): { repo: FakePlatformRepo; registrations: TenantRegistrations } {
  const repo = new FakePlatformRepo();
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers(["erp"]), identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"),
    approvedTags: { erp: { "example-engine": OLD, "example-gone": OLD } }, ...TEST_BUNDLE,
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  repo.seed(repo.booksBranch, "charts/example-engine/pins-prod.yaml", `builds:\n  - { name: example-engine, image: example-engine-image, tag: "0.1.9-stable-20260926120000-abc1234" }\n`);
  return { repo, registrations: new TenantRegistrations(repo) };
}

describe("tenantHeldPins", () => {
  it("holds the tenant's own version of every build its charts pin, keyed on the pinned image, and its apps bundle", async () => {
    const { registrations } = books();
    const hits = await tenantHeldPins(registrations);
    expect(hits.map((h) => `${h.pin.image}:${h.pin.tag}`)).toEqual([`example-engine-image:${OLD}`, `${TEST_BUNDLE.appsImage}:${TEST_BUNDLE.appsImageTag}`]);
  });

  it("refuses when a tenant registration cannot be read, rather than leave what it holds unprotected", async () => {
    const { repo, registrations } = books();
    repo.seed(repo.booksBranch, "registrations/abcdefghjkmn/prod.yaml", "cluster: [not a registration\n");
    await expect(tenantHeldPins(registrations)).rejects.toThrow(/cannot all be read/);
  });
});
