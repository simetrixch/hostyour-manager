import { describe, it, expect } from "vitest";
import { tenantPlacement, TENANT_GUID_PLACEHOLDER, type TenantPlacementTarget } from "./tenantPlacement.ts";
import { guid } from "../../shared/tenant.ts";

// The create-tenant wizard's placement read-out: what the operator is told about
// where a tenant will land, before anything is minted. Pure, so it is tested here rather than through
// TenantCreate.tsx — the same factoring tenantRows.test.ts and runScreen.test.ts describe.
//
// The `guid` schema is imported from shared/tenant.ts on purpose: the honesty rule this file guards is
// not "the string contains angle brackets", it is "what we show where the guid goes MUST NOT be a thing
// the platform would accept as a guid". Asserting that against the real schema is the only version of
// that rule that cannot drift from the server's.

const targets: TenantPlacementTarget[] = [
  { id: "cl_s1", domain: "s1.example.com", stage: "prod" },
  { id: "cl_dev1", domain: "dev1.example.com", stage: "dev" },
];

describe("tenantPlacement", () => {
  // The whole point: the stage is NOT an operator choice, it is a property of the cluster
  // installation (clusters.stage, written by deploy-slave and re-attested against the cluster's
  // hostyour-cloud-deploy-state ConfigMap by attest-target). Picking the other cluster must therefore move
  // the stage AND everything derived from it — that is what makes this a read-out rather than a field.
  it("reads the stage and domain off the chosen cluster — a different cluster is a different stage", () => {
    expect(tenantPlacement("cl_s1", targets)).toEqual({
      stage: "prod",
      domain: "s1.example.com",
      registrationPath: "registrations/<guid>/prod.yaml",
      namespaces: ["<guid>-auth", "<guid>-jobs", "<guid>-report"],
    });
    expect(tenantPlacement("cl_dev1", targets)).toMatchObject({ stage: "dev", registrationPath: "registrations/<guid>/dev.yaml" });
  });

  // The registration path must be the shape the tenant registry actually writes and guards
  // (server/domains/onboarding/tenant-registry.ts `registrationPath` + TENANT_REGISTRATION_GUARD:
  // registrations/<guid>/<stage>.yaml). A read-out the operator cannot check against catalog is
  // worse than none, because it reads as a fact.
  it("names the registration file in the shape the tenant registry writes", () => {
    const p = tenantPlacement("cl_s1", targets);
    expect(p?.registrationPath).toBe(`registrations/${TENANT_GUID_PLACEHOLDER}/prod.yaml`);
  });

  // The namespace rule: a tenant is not one namespace, it is one PER MEMBER (tenant-fanout.ts
  // `memberNamespace` — <guid>-<member>; there is no bare-guid namespace anywhere any more). With no
  // app picked, the read-out is exactly the mandatory trio, in the server's own order
  // (tenant-fanout.ts TENANT_TRIO), so the wizard's set and the run's own step log name the members
  // identically — and none of them is the bare guid, which would send an operator's kubectl at a
  // namespace that does not exist.
  it("shows one namespace per trio member — never the bare guid", () => {
    const p = tenantPlacement("cl_s1", targets);
    expect(p?.namespaces).toEqual([
      `${TENANT_GUID_PLACEHOLDER}-auth`,
      `${TENANT_GUID_PLACEHOLDER}-jobs`,
      `${TENANT_GUID_PLACEHOLDER}-report`,
    ]);
    expect(p?.namespaces).not.toContain(TENANT_GUID_PLACEHOLDER);
    for (const ns of p?.namespaces ?? []) expect(ns.startsWith(`${TENANT_GUID_PLACEHOLDER}-`)).toBe(true);
  });

  // Picking apps in the wizard appends one namespace per app, in the order picked, AFTER the trio — the
  // same order tenantMembers (tenant-fanout.ts) lists them in, so the read-out and the run's own step
  // log never disagree on which member is which.
  it("appends one namespace per picked app, in order, after the trio", () => {
    const p = tenantPlacement("cl_s1", targets, ["web", "buildproject"]);
    expect(p?.namespaces).toEqual([
      `${TENANT_GUID_PLACEHOLDER}-auth`,
      `${TENANT_GUID_PLACEHOLDER}-jobs`,
      `${TENANT_GUID_PLACEHOLDER}-report`,
      `${TENANT_GUID_PLACEHOLDER}-web`,
      `${TENANT_GUID_PLACEHOLDER}-buildproject`,
    ]);
    for (const ns of p?.namespaces ?? []) expect(ns.startsWith(`${TENANT_GUID_PLACEHOLDER}-`)).toBe(true);
  });

  // THE honesty regression. The guid does not exist when this is rendered — create-tenant's planner
  // mints it server-side (create-tenant.run.ts `mintFreeGuid`) when the operator presses "Validate &
  // plan" — so every place it will appear must carry a visible placeholder that the platform itself
  // would reject as a guid. An example/fabricated identifier here is a string an operator can copy into
  // a Vault path (<stage>/tenants/<guid>) or a kubectl command and act on the wrong tenant with.
  it("fabricates no identifier: what stands in for the guid cannot BE a guid", () => {
    const p = tenantPlacement("cl_s1", targets);
    expect(guid.safeParse(TENANT_GUID_PLACEHOLDER).success).toBe(false);
    // The placeholder is visible in every place the guid will appear, and no path or namespace carries
    // another guid-shaped run of characters that could be read as one.
    expect(p?.registrationPath).toContain(TENANT_GUID_PLACEHOLDER);
    for (const ns of p?.namespaces ?? []) expect(ns).toContain(TENANT_GUID_PLACEHOLDER);
    for (const segment of (p?.registrationPath ?? "").split("/")) {
      expect(guid.safeParse(segment).success).toBe(false);
    }
  });

  // Nothing to show is shown as nothing: no cluster picked yet, the targets request still in flight, or
  // an id no row carries. A partial placement would print `registrations/<guid>/.yaml` — a path that exists
  // nowhere — under a heading that claims to state where the tenant lands.
  it("claims no placement before a cluster is chosen, while targets load, or for an unknown cluster", () => {
    expect(tenantPlacement("", targets)).toBeNull();
    expect(tenantPlacement("cl_s1", null)).toBeNull();
    expect(tenantPlacement("cl_s1", [])).toBeNull();
    expect(tenantPlacement("cl_gone", targets)).toBeNull();
  });
});
