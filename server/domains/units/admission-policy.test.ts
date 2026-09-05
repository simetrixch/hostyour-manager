import { describe, it, expect } from "vitest";
import { renderTenantMemberAdmissionPolicy, unitApexFromChain, tenantMemberAdmissionPolicyName, TENANT_MANAGED_LABEL } from "./admission-policy.ts";
import { TENANT_PROJECT_LABEL } from "../../adapters/kube/port.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

const APEX = "example.com";

describe("unitApexFromChain", () => {
  const common = { path: "clusters/platform/values-common.yaml", content: `global:\n  unitApex: platform.${APEX}\n` };
  const stage = { path: "clusters/platform/values-prod.yaml", content: "global:\n  env: prod\n" };
  const profile = { path: clusterMapPath("s1.example"), content: `global:\n  unitApex: ${APEX}\n` };

  it("takes the LAST file that states it — the cluster's own profile wins over the platform default", () => {
    expect(unitApexFromChain([common, stage, profile])).toBe(APEX);
  });

  it("falls back through the chain when the cluster's profile states none", () => {
    expect(unitApexFromChain([common, stage, { path: clusterMapPath("s1.example"), content: "global: {}\n" }])).toBe(`platform.${APEX}`);
  });

  it("refuses a chain that states it nowhere, naming the files it read", async () => {
    expect(() => unitApexFromChain([stage])).toThrowError(/platform\/values-prod\.yaml/);
  });
});

// The fence against the ADMISSION REQUEST a unit sends. `evaluatesFor` implements the part of
// the upstream match contract the defect lived in — admissionregistration.k8s.io/v1 MatchResources:
// "If the object itself is a namespace, the matching is performed on object.metadata.labels", and
// the API server stamps `kubernetes.io/metadata.name` on every namespace before admission — and
// `admit` then runs the policy's rendered CEL itself. The CEL this module emits IS JavaScript once
// `==`/`!=` are widened and `has()` is rewritten, so the strings under test are evaluated, never
// re-implemented.

/** One admission request as the policy sees it: the plural resource under review, the namespace the
 *  request addresses ("" for a cluster-scoped object), and the object with every server-side stamp
 *  already applied. */
interface Review {
  resource: "ingresses" | "services" | "namespaces";
  operation: "CREATE" | "UPDATE";
  namespace: string;
  object: { metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> } };
}

type Rendered = ReturnType<typeof renderTenantMemberAdmissionPolicy>;

/** CEL's `all` macro over a list (its elements) or a map (its keys). The rewrite below turns
 *  `<coll>.all(<v>, <pred>)` into `all(<coll>, (<v>) => <pred>)`, which keeps the parentheses
 *  balanced and so survives the nested form the tls clause uses. */
const allMacro = (collection: unknown, predicate: (item: string) => boolean): boolean =>
  (Array.isArray(collection) ? (collection as string[]) : Object.keys(collection as object)).every(predicate);

function celPredicate(expression: string): (request: unknown, object: unknown) => boolean {
  const js = expression
    .replaceAll(" == ", " === ")
    .replaceAll(" != ", " !== ")
    .replace(/has\(([^)]+)\)/g, "($1 !== undefined)")
    .replace(/([A-Za-z_][\w.[\]'"]*)\.all\(([a-z]+), /g, "all($1, ($2) => ");
  const compiled = new Function("request", "object", "all", `return (${js});`) as (
    request: unknown,
    object: unknown,
    all: typeof allMacro,
  ) => boolean;
  return (request, object) => compiled(request, object, allMacro);
}

/** Does the policy evaluate this request at all? Models the whole match pipeline — matchConstraints,
 *  a Binding selector whether present or not (so the test refuses the namespaceSelector coming
 *  back), then matchConditions, where absence matches all requests. */
function evaluatesFor({ policy, binding }: Rendered, review: Review): boolean {
  const ruleHit = policy.spec.matchConstraints.resourceRules.some(
    (r) => r.resources.includes(review.resource) && r.operations.includes(review.operation),
  );
  if (!ruleHit) return false;
  const selector = (binding.spec as { matchResources?: { namespaceSelector?: { matchLabels: Record<string, string> } } }).matchResources?.namespaceSelector;
  if (selector !== undefined) {
    // For an object that IS a Namespace the selector reads the OBJECT's own labels; for a
    // namespaced object, the labels of the namespace it sits in — its name label at least.
    const labels: Record<string, string> =
      review.resource === "namespaces"
        ? { ...review.object.metadata.labels, "kubernetes.io/metadata.name": review.object.metadata.name }
        : { "kubernetes.io/metadata.name": review.namespace };
    if (!Object.entries(selector.matchLabels).every(([k, v]) => labels[k] === v)) return false;
  }
  const request = { resource: { resource: review.resource }, namespace: review.namespace, operation: review.operation };
  return (policy.spec.matchConditions ?? []).every((c) => celPredicate(c.expression)(request, review.object));
}

/** The verdict: was the policy evaluated at all, and which clause messages refused the request. */
function admit(rendered: Rendered, review: Review): { evaluated: boolean; denied: string[] } {
  if (!evaluatesFor(rendered, review)) return { evaluated: false, denied: [] };
  const request = { resource: { resource: review.resource }, namespace: review.namespace, operation: review.operation };
  const denied = rendered.policy.spec.validations
    .filter((v) => !celPredicate(v.expression)(request, review.object))
    .map((v) => v.message);
  return { evaluated: true, denied };
}

/** A Namespace admission as it reaches the policy: the API server has stamped the metadata.name
 *  label, and — where ArgoCD applied the object — the tracking-id of the owning Application. */
function namespaceReview(name: string, trackingId?: string, labels?: Record<string, string>): Review {
  return {
    resource: "namespaces",
    operation: "CREATE",
    namespace: "",
    object: {
      metadata: {
        name,
        labels: { "kubernetes.io/metadata.name": name, ...labels },
        ...(trackingId !== undefined ? { annotations: { "argocd.argoproj.io/tracking-id": trackingId } } : {}),
      },
    },
  };
}

// The TENANT MEMBER boundary — the same Namespace clauses with the tenant's own granted set. The
// member fixtures mirror the tenant fan-out naming: namespace <guid>-<member>, generated Application
// <guid>-<member>-<stage> (the tracking-id prefix).
const GUID = "abc123def456";
// The IdP member carries the redis-consumer label because the product DECLARES it for that member
// (TenantMemberSchema.namespaceLabels), not because the platform knows a member called "auth".
const auth = renderTenantMemberAdmissionPolicy({ guid: GUID, member: "auth", stage: "prod", namespaceLabels: { "platform/redis-consumer": "true" } });
const jobs = renderTenantMemberAdmissionPolicy({ guid: GUID, member: "jobs", stage: "prod" });
const authNs = `${GUID}-auth`;
const authTracking = `${GUID}-auth-prod:/Namespace:/${authNs}`;

describe("renderTenantMemberAdmissionPolicy", () => {
  it("names the policy tenant-<guid>-<member>, apart from every consumer-<name>, and labels both halves tenant-managed", () => {
    expect(auth.policy.metadata.name).toBe(tenantMemberAdmissionPolicyName(GUID, "auth"));
    expect(auth.policy.metadata.name).toBe(`tenant-${authNs}`);
    expect(auth.binding.metadata.name).toBe(auth.policy.metadata.name);
    expect(auth.binding.spec.policyName).toBe(auth.policy.metadata.name);
    for (const m of [auth.policy.metadata, auth.binding.metadata]) {
      expect(m.labels).toEqual({ [TENANT_PROJECT_LABEL.key]: TENANT_PROJECT_LABEL.value });
    }
  });

  it("fails closed and DENIES, like the consumer boundary", () => {
    expect(auth.policy.spec.failurePolicy).toBe("Fail");
    expect(auth.binding.spec.validationActions).toEqual(["Deny"]);
  });

  it("watches ONLY the Namespace kind — a member's chart is the platform's own, so no Ingress or Service clause", () => {
    expect(auth.policy.spec.matchConstraints.resourceRules).toEqual([
      { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["namespaces"] },
    ]);
    for (const v of auth.policy.spec.validations) {
      expect(v.expression).not.toContain("'ingresses'");
      expect(v.expression).not.toContain("'services'");
    }
  });

  it("carries no matchConditions and no binding selector — every Namespace admission is evaluated, so the own-name clause reaches a foreign name", () => {
    expect(auth.policy.spec.matchConditions).toEqual([]);
    expect(auth.binding.spec).toEqual({ policyName: `tenant-${authNs}`, validationActions: ["Deny"] });
  });
});

describe("the fence against the admission request a tenant member sends", () => {
  it("DENIES the ESO workload label on the member's own namespace — the binding of the strongest ESO role on every slave", () => {
    // A catalog chart change rendering `kind: Namespace, name: <guid>-auth, labels:
    // {hostyour.cloud/workload: "true"}` would bind the external-secrets Vault role
    // (hostyour-cloud/base/lib/seed-vault.sh selects on exactly this label) and read the cluster
    // mount's whole app tier. This is the request the fence exists to refuse.
    const review = namespaceReview(authNs, authTracking, { "hostyour.cloud/workload": "true" });
    const { evaluated, denied } = admit(auth, review);
    expect(evaluated).toBe(true);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toContain("a tenant member namespace may carry no label under");
  });

  it("admits the exact labels the tenant ApplicationSets stamp on the auth member — the platform's own managed-namespace write", () => {
    // ArgoCD applies the managed namespace under the member's own tracking id, so the
    // managedNamespaceMetadata of tenants-appset.yaml reaches this policy exactly like a chart
    // would; a fence that refused it would deadlock every tenant sync.
    const review = namespaceReview(authNs, authTracking, {
      "platform/tenant": GUID,
      [TENANT_MANAGED_LABEL]: "true",
      "platform/db-consumer": "true",
      "platform/redis-consumer": "true",
      // a label in no platform namespace: the member's own business, passed unread
      "app.kubernetes.io/managed-by": "argocd",
    });
    expect(admit(auth, review)).toEqual({ evaluated: true, denied: [] });
  });

  it("admits the redis reach label on the auth member ALONE — no other member may write itself into that NetworkPolicy's selector", () => {
    const jobsNs = `${GUID}-jobs`;
    const jobsTracking = `${GUID}-jobs-prod:/Namespace:/${jobsNs}`;
    const stamped = { "platform/tenant": GUID, [TENANT_MANAGED_LABEL]: "true", "platform/db-consumer": "true" };
    expect(admit(jobs, namespaceReview(jobsNs, jobsTracking, stamped))).toEqual({ evaluated: true, denied: [] });
    expect(admit(jobs, namespaceReview(jobsNs, jobsTracking, { ...stamped, "platform/redis-consumer": "true" })).denied).toHaveLength(1);
  });

  it("refuses EVERY pod-security label — the tenant appsets stamp none, so not even 'restricted' is granted", () => {
    for (const value of ["privileged", "restricted"]) {
      const review = namespaceReview(authNs, authTracking, { "pod-security.kubernetes.io/enforce": value });
      expect(admit(auth, review).denied, `pod-security enforce=${value} was admitted`).toHaveLength(1);
    }
  });

  it("refuses a platform/tenant label naming a FOREIGN guid — a member cannot re-badge its namespace into another tenant's selector", () => {
    const review = namespaceReview(authNs, authTracking, { "platform/tenant": "zzzzzzzzzzzz" });
    expect(admit(auth, review).denied).toHaveLength(1);
  });

  it("DENIES a member creating a sibling's namespace with the own-namespace clause", () => {
    const review = namespaceReview(`${GUID}-jobs`, `${GUID}-auth-prod:/Namespace:/${GUID}-jobs`);
    expect(admit(auth, review).denied).toContain(`a tenant member may only create its own namespace ${authNs}`);
  });

  it("EVALUATES for a foreign namespace name and passes another actor's namespace through the CLAUSES, not around the policy", () => {
    // The platform's own namespaces carry no tracking id; a consumer's and a sibling member's carry
    // their own Applications'. All are evaluated (nothing skips a Namespace admission) and pass on
    // the ownership term inside the clauses.
    expect(evaluatesFor(auth, namespaceReview("vault"))).toBe(true);
    expect(admit(auth, namespaceReview("vault"))).toEqual({ evaluated: true, denied: [] });
    expect(admit(auth, namespaceReview("acme", "acme-prod:/Namespace:/acme"))).toEqual({ evaluated: true, denied: [] });
    expect(admit(auth, namespaceReview(`${GUID}-jobs`, `${GUID}-jobs-prod:/Namespace:/${GUID}-jobs`))).toEqual({ evaluated: true, denied: [] });
  });
});
