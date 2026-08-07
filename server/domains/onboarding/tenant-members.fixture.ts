// The member set a tenant of the TEST product has — the fixture side of resolveMembers, stated here
// because the platform holds no such list: which members a tenant has is its product's business, and
// a test that assumed three fixed names is exactly the assumption the fan-out stopped making.
//
// Two shapes, because two places record two different things:
//   - a REGISTRATION carries the whole resolved set, standing members AND one per app, each with the
//     charts it deploys — that is what the ApplicationSet fans out over;
//   - a tenants ROW carries the standing names only, because an app's presence is its tenant_apps row
//     and its status, and every reader unions the two.
import type { TenantMemberRecord } from "../../../shared/tenant.ts";
import { seedQuota } from "../../../shared/unit-size.ts";

/** The standing members every tenant of the test product has. */
export const STANDING_MEMBER_NAMES: string[] = ["auth", "jobs", "report"];

/** The ArgoCD namespace these fixtures render AppProjects into. The runs themselves read the
 *  namespace off resolveClusterKube(clusterId) — a slave's projects live in the per-slave ArgoCD
 *  namespace on the master — so this is the test's own choice, not a production constant. */
export const ARGO_NS = "argocd";

/** Those three as the records a registration carries: one chart each, no extra namespace labels. */
export const STANDING_MEMBERS: TenantMemberRecord[] = STANDING_MEMBER_NAMES.map((name) => ({
  name,
  namespaceLabels: {},
  sources: [{ chart: `charts/example-${name}`, valueFiles: [], values: {} }],
}));

/** The registration's members[] for a tenant that selected these apps: the standing set, then one
 *  member per app carrying the two sources a selected app renders (an engine and a front), the way
 *  the test product's manifest declares them under perApp. */
export function testMembers(apps: readonly ({ name: string; [k: string]: unknown } | string)[] = []): TenantMemberRecord[] {
  const names = apps.map((a) => (typeof a === "string" ? a : a.name));
  return [
    ...STANDING_MEMBERS,
    ...names.map((name) => ({
      name,
      namespaceLabels: {},
      sources: [
        { chart: "charts/example-engine", valueFiles: [`values-${name}.yaml`], values: { fullnameOverride: `example-engine-${name}` } },
        { chart: name === "web" ? "charts/example-web" : "charts/example-ui", valueFiles: [], values: {} },
      ],
    })),
  ];
}

/** The ceiling a test tenant's member namespaces are bounded by — the shipped `small` figures. Lives
 *  here beside the member set for the same reason that does: every tenant registration a test builds
 *  needs one, and a literal repeated per file is a literal free to drift from what the seed says. */
export const TEST_QUOTA = seedQuota("small");
