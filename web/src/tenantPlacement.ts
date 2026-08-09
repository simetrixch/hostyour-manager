// WHERE a tenant will land, derived from the ONE thing the create-tenant wizard actually lets the
// operator pick: the target cluster. Kept OUT of TenantCreate.tsx the same way tenantRows.ts holds the
// tenants-page status rule and runScreen.ts the Run screen's honesty rules — it is pure, so it is stated
// and tested once here rather than through a component (vitest.config.ts runs web/**/*.test.ts in the
// node environment; there is no DOM harness in this repo).
//
// WHY THIS IS A READ-OUT AND NOT A PICKER. That issue asked for an explicit
// stage selector and was closed against building one, because the stage is a physical property of the
// cluster installation, not an operator choice. ONE CLUSTER IS EXACTLY ONE STAGE, and three independent
// places already enforce it:
//   1. `clusters.stage` is written when the cluster is installed (server/domains/runs/defs/deploy-slave.ts)
//      and the cluster declares the same stage itself in its hostyour-cloud-deploy-state ConfigMap;
//   2. attest-target — step 0 of EVERY mutating tenant run — refuses on any stage/domain drift
//      against that ConfigMap (create-tenant.run.ts → lifecycle.ts `assertDeployState`);
//   3. the stage is baked into the identities downstream: the Vault path <stage>/tenants/<guid>, the ESO
//      role, the GitOps pointer directory and the values-<stage>.yaml chart overlay.
// A stage field in the wizard could therefore only ever repeat what the cluster already decides — or, if
// the guard were loosened to honour it, place the tenant under a wrong Vault path and a non-existent
// GitOps stage directory. So the wizard has nothing to CHOOSE here. What it owes the operator is to SHOW
// what the choice already made implies, BEFORE the plan mints anything — which is all this module is.
// Nothing here is submitted: createTenant still sends only `clusterId` (web/src/api.ts
// buildCreateTenantBody), and the server derives stage + domain from the cluster row itself.

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
 *  (server/domains/onboarding/tenant-fanout.ts `TENANT_TRIO`). Restated here because shared/ is the
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
  /** The cluster's stage — READ off the chosen cluster row, never chosen here (see the header). */
  stage: string;
  /** The cluster's public domain, likewise read off that row. */
  domain: string;
  /** The GitOps registration FILE in catalog, `registrations/<guid>/<stage>.yaml` — the exact
   *  path the tenant registry writes and guards (server/domains/onboarding/tenant-registry.ts
   *  `registrationPath` + TENANT_REGISTRATION_GUARD). ONE file: the guid is the directory, the stage is
   *  the file name, and the body carries neither. */
  registrationPath: string;
  /** The Kubernetes namespaces on that cluster — ONE PER MEMBER, each `<guid>-<member>`
   *  (server/domains/onboarding/tenant-fanout.ts `memberNamespace`). A tenant is not one namespace: the
   *  trio auth/jobs/report is there for every tenant and each app the operator picks adds its own, so
   *  what the wizard shows is the whole set it is about to create. Each namespace is also the name of
   *  that member's AppProject. */
  namespaces: string[];
}

/** Derive the placement of the tenant about to be created, or null when there is nothing honest to show
 *  yet — no cluster chosen, targets still loading, or an id no target row carries. Null rather than a
 *  partial answer: a placement with a blank stage would print `registrations/<guid>/.yaml`, a path that
 *  exists nowhere, and the point of this read-out is that every line of it is checkable. */
export function tenantPlacement(
  clusterId: string,
  targets: readonly TenantPlacementTarget[] | null,
  apps: readonly string[] = [],
): TenantPlacement | null {
  const target = (targets ?? []).find((t) => t.id === clusterId);
  if (!target) return null;
  return {
    stage: target.stage,
    domain: target.domain,
    registrationPath: `registrations/${TENANT_GUID_PLACEHOLDER}/${target.stage}.yaml`,
    // The trio first, then the picked apps — the same order the server's tenantMembers lists them in,
    // so the read-out and the run's own step log name the members identically.
    namespaces: [...TENANT_TRIO, ...apps].map((member) => `${TENANT_GUID_PLACEHOLDER}-${member}`),
  };
}
