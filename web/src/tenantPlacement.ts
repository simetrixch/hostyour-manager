// WHERE a tenant will land, derived from the two things the create-tenant wizard lets the operator
// pick — the tenant's own stage and the target cluster — and shown before the plan mints anything.
// Kept OUT of TenantCreate.tsx the same way tenantRows.ts holds the tenants-page status rule and
// runScreen.ts the Run screen's honesty rules — it is pure, so it is stated and tested once here rather
// than through a component (vitest.config.ts runs web/**/*.test.ts in the node environment; there is
// no DOM harness in this repo). Nothing here is submitted: the placement only prints what the
// server will compose from the same two inputs (tenant-fanout.ts memberNamespace,
// tenant-registrations.ts registrationPath).

/** The placeholder that stands where the tenant's guid will be. It is a PLACEHOLDER on purpose and must
 *  stay one that cannot be mistaken for an identifier: the guid does not exist yet when this is rendered
 *  — create-tenant's streaming planner mints it server-side (create-tenant.run.ts `mintFreeGuid`, called
 *  from planStream) once the operator presses "Validate & plan", collision-checked against the pointers
 *  that already stand. Showing a plausible-looking example guid instead would hand the operator a string
 *  they could copy into a Vault path or a kubectl command and act on the wrong tenant, so the angle
 *  brackets are load-bearing: `<guid>` is rejected by the `guid` schema (shared/tenant.ts — 12 chars of
 *  Crockford base32) and by DNS-label validation, i.e. it cannot BE a tenant anywhere in the platform. */
export const TENANT_GUID_PLACEHOLDER = "<guid>";

/** The three members every tenant always has, in the order the server lists them
 *  (server/domains/units/tenant-fanout.ts `TENANT_TRIO`). Restated here because shared/ is the
 *  only code the browser bundle may import and this list lives in the server domain layer; the
 *  read-out would otherwise have nothing to show for the members no operator chooses. */
const TENANT_TRIO = ["auth", "jobs", "report"] as const;

/** The fields of one create-tenant target row this derivation needs (GET /api/tenants/targets →
 *  TenantTargetView, web/src/api.ts). Structural on purpose, so the rule can be stated and tested
 *  without the transport type. */
export interface TenantPlacementTarget {
  id: string;
  domain: string;
  stage: string;
}

/** Where the tenant lands, in the four terms the operator can check against the platform. */
export interface TenantPlacement {
  /** The tenant's own stage — the operator's pick, echoed. */
  stage: string;
  /** The cluster's public domain, read off the chosen cluster row. */
  domain: string;
  /** The GitOps registration FILE in catalog, `registrations/<guid>/<stage>.yaml` — the exact
   *  path the tenant registrations writer writes and guards (server/domains/units/tenant-registrations.ts
   *  `registrationPath` + TENANT_REGISTRATION_GUARD). ONE file: the guid is the directory, the stage is
   *  the file name, and the body carries neither. */
  registrationPath: string;
  /** The Kubernetes namespaces on that cluster — ONE PER MEMBER, each `<guid>-<member>-<stage>`
   *  (server/domains/units/tenant-fanout.ts `memberNamespace`). A tenant is not one namespace: the
   *  trio auth/jobs/report is there for every tenant and each app the operator picks adds its own, so
   *  what the wizard shows is the whole set it is about to create. Each namespace is also the name of
   *  that member's AppProject. */
  namespaces: string[];
}

/** Derive the placement of the tenant about to be created, or null when there is nothing honest to show
 *  yet — no stage or no cluster chosen, targets still loading, or an id no target row carries. Null
 *  rather than a partial answer: a placement with a blank stage would print `registrations/<guid>/.yaml`,
 *  a path that exists nowhere, and the point of this read-out is that every line of it is checkable. */
export function tenantPlacement(
  stage: string,
  clusterId: string,
  targets: readonly TenantPlacementTarget[] | null,
  apps: readonly string[] = [],
): TenantPlacement | null {
  const target = (targets ?? []).find((t) => t.id === clusterId);
  if (!target || stage === "") return null;
  return {
    stage,
    domain: target.domain,
    registrationPath: `registrations/${TENANT_GUID_PLACEHOLDER}/${stage}.yaml`,
    // The trio first, then the picked apps — the same order the server's tenantMembers lists them in,
    // so the read-out and the run's own step log name the members identically.
    namespaces: [...TENANT_TRIO, ...apps].map((member) => `${TENANT_GUID_PLACEHOLDER}-${member}-${stage}`),
  };
}
