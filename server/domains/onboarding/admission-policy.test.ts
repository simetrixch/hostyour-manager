import { describe, it, expect } from "vitest";
import { renderConsumerAdmissionPolicy, renderTenantMemberAdmissionPolicy, unitApexFromChain, consumerAdmissionPolicyName, tenantMemberAdmissionPolicyName, TENANT_MANAGED_LABEL } from "./admission-policy.ts";
import { CONSUMER_PROJECT_LABEL, TENANT_PROJECT_LABEL } from "../../adapters/kube/port.ts";

const APEX = "example.com";
const ARGO_APP = "acme-prod";

const { policy, binding } = renderConsumerAdmissionPolicy({ name: "acme", namespace: "acme", unitApex: APEX, argoAppName: ARGO_APP });

/** The clause guarding ONE resource, found by the resource name its own guard tests for. */
function clauseFor(resource: string, contains: string): string {
  const found = policy.spec.validations.filter((v) => v.expression.includes(`request.resource.resource != '${resource}'`) && v.expression.includes(contains));
  expect(found).toHaveLength(1);
  return found[0]!.expression;
}

describe("unitApexFromChain", () => {
  const common = { path: "platform/values-common.yaml", content: `global:\n  unitApex: platform.${APEX}\n` };
  const stage = { path: "platform/values-prod.yaml", content: "global:\n  env: prod\n" };
  const profile = { path: "installation/profile.yaml", content: `global:\n  unitApex: ${APEX}\n` };

  it("takes the LAST file that states it — the cluster's own profile wins over the platform default", () => {
    expect(unitApexFromChain([common, stage, profile])).toBe(APEX);
  });

  it("falls back through the chain when the cluster's profile states none", () => {
    expect(unitApexFromChain([common, stage, { path: "installation/profile.yaml", content: "global: {}\n" }])).toBe(`platform.${APEX}`);
  });

  it("refuses a chain that states it nowhere, naming the files it read", async () => {
    expect(() => unitApexFromChain([stage])).toThrowError(/platform\/values-prod\.yaml/);
  });
});

describe("renderConsumerAdmissionPolicy", () => {
  it("names the policy and its binding after the unit, and labels both as Controller-managed", () => {
    expect(policy.metadata.name).toBe(consumerAdmissionPolicyName("acme"));
    expect(binding.metadata.name).toBe(policy.metadata.name);
    expect(binding.spec.policyName).toBe(policy.metadata.name);
    for (const m of [policy.metadata, binding.metadata]) {
      expect(m.labels).toEqual({ [CONSUMER_PROJECT_LABEL.key]: CONSUMER_PROJECT_LABEL.value });
    }
  });

  it("fails closed and DENIES — an unevaluable clause refuses the object, a failing one is not a warning", () => {
    expect(policy.spec.failurePolicy).toBe("Fail");
    expect(binding.spec.validationActions).toEqual(["Deny"]);
  });

  it("watches exactly Ingress, Service and Namespace on CREATE + UPDATE", () => {
    expect(policy.spec.matchConstraints.resourceRules.map((r) => r.resources[0])).toEqual(["ingresses", "services", "namespaces"]);
    for (const rule of policy.spec.matchConstraints.resourceRules) {
      expect(rule.operations).toEqual(["CREATE", "UPDATE"]);
    }
  });

  it("scopes in the policy's matchConditions, not the binding — a namespaceSelector would be matched against a Namespace object's own labels and skip every foreign name", () => {
    expect(policy.spec.matchConditions).toEqual([
      { name: "unit-scope", expression: "request.resource.resource == 'namespaces' || request.namespace == 'acme'" },
    ]);
    expect(binding.spec).toEqual({ policyName: "consumer-acme", validationActions: ["Deny"] });
  });

  it("pins the Ingress to the unit's ONE host and offers no wildcard", () => {
    const expr = clauseFor("ingresses", "spec.rules");
    expect(expr).toContain(`r.host == 'acme.${APEX}'`);
    // Every rule, not merely one of them, and a rule with no host is a violation rather than an exemption.
    expect(expr).toContain("object.spec.rules.all(r, has(r.host)");
    // No sub-host is admitted: after the one-record DNS form, nothing would resolve one anyway.
    expect(expr).not.toContain("*.");
    expect(expr).not.toContain("endsWith");
  });

  it("pins a Service to ClusterIP", () => {
    const expr = clauseFor("services", "spec.type");
    expect(expr).toContain("object.spec.type == 'ClusterIP'");
    expect(expr).toContain("!has(object.spec.type)"); // an un-defaulted submission is not a violation
  });

  it("pins a Namespace this unit creates to its OWN name, and constrains nothing else on the cluster", () => {
    const expr = clauseFor("namespaces", "object.metadata.name ==");
    expect(expr).toContain("object.metadata.name == 'acme'");
    // The reach limiter: a Namespace ArgoCD did not stamp for THIS unit's Application passes through.
    expect(expr).toContain(`object.metadata.annotations['argocd.argoproj.io/tracking-id'].startsWith('${ARGO_APP}:')`);
    // An object with no annotations at all is not this unit's, so the whole ownership term is negated
    // rather than each half being tested for absence.
    expect(expr).toContain("|| !(has(object.metadata.annotations)");
  });

  it("fences the reserved label namespaces on a namespace the unit creates, admitting only what the platform stamps", () => {
    // ONE clause for the whole class: each prefix is a grant somewhere — a Vault role's namespace
    // selector, the redis NetworkPolicy, Pod Security Admission — so what a unit's own Namespace
    // object may say under them is exactly the platform's own stamps and nothing else.
    const expr = clauseFor("namespaces", "object.metadata.labels.all(k,");
    for (const prefix of ["hostyour.cloud/", "platform/", "pod-security.kubernetes.io/"]) {
      expect(expr).toContain(`k.startsWith('${prefix}')`);
    }
    expect(expr).toContain("(k == 'pod-security.kubernetes.io/enforce' && object.metadata.labels[k] == 'restricted')");
    expect(expr).toContain("(k == 'hostyour.cloud/consumer-name' && object.metadata.labels[k] == 'acme')");
    // No redis claim in this render, so the reach label is granted by nothing.
    expect(expr).not.toContain("platform/redis-consumer");
    expect(expr).toContain(`object.metadata.annotations['argocd.argoproj.io/tracking-id'].startsWith('${ARGO_APP}:')`);
    const message = policy.spec.validations.find((v) => v.expression === expr)!.message;
    expect(message).toContain("pod-security.kubernetes.io/");
  });

  it("gives every clause a message that names the rule, not the expression", () => {
    for (const v of policy.spec.validations) {
      expect(v.message.length).toBeGreaterThan(20);
      expect(v.message).not.toContain("object.");
    }
  });

  it("without an attested fqdn the Ingress clause admits exactly the platform address — the message says FQDN, singular", () => {
    const clause = policy.spec.validations.find((v) => v.expression.includes("'ingresses'"))!;
    expect(clause.expression.match(/r\.host ==/g)).toHaveLength(1);
    expect(clause.message).toBe(`a consumer Ingress may only serve the FQDN acme.${APEX}`);
  });

  it("fences spec.tls to the granted set — a tls host is a certificate order, so an ungranted one is refused even when no rule serves it", () => {
    const expr = clauseFor("ingresses", "spec.tls.all(t, has(t.hosts)");
    expect(expr).toContain(`h == 'acme.${APEX}'`);
    // Every entry and every host; an entry without hosts is a violation, not an exemption.
    expect(expr).toContain("object.spec.tls.all(t, has(t.hosts) && t.hosts.all(h,");
    // An Ingress that terminates no TLS is not refused for it.
    expect(expr).toContain("!has(object.spec.tls)");
  });

  it("keeps the platform FQDN in a tls entry of its own — one atomic ACME order must not tie its renewal to a foreign name", () => {
    const expr = clauseFor("ingresses", "t.hosts.size() > 1");
    expect(expr).toContain(`'acme.${APEX}' in t.hosts`);
    expect(expr).toContain("!has(object.spec.tls)");
  });
});

describe("renderConsumerAdmissionPolicy with an attested fqdn", () => {
  // The REGISTRATION's attested value — never the manifest's declaration — is what reaches here.
  const FQDN = "shop.example.org";
  const granted = renderConsumerAdmissionPolicy({ name: "acme", namespace: "acme", unitApex: APEX, argoAppName: ARGO_APP, fqdn: FQDN });
  const clause = granted.policy.spec.validations.find((v) => v.expression.includes("'ingresses'"))!;

  it("admits the attested fqdn IN ADDITION to the unit's platform address — both, never instead", () => {
    expect(clause.expression).toContain(`r.host == 'acme.${APEX}' || r.host == '${FQDN}'`);
    // still every rule, still no rule without an FQDN, still no wildcard
    expect(clause.expression).toContain("object.spec.rules.all(r, has(r.host)");
    expect(clause.expression).not.toContain("*.");
    expect(clause.expression).not.toContain("endsWith");
  });

  it("names both granted FQDNs in the message", () => {
    expect(clause.message).toBe(`a consumer Ingress may only serve the FQDNs acme.${APEX} and ${FQDN}`);
  });

  it("admits the attested fqdn in the tls fence, and STILL refuses it beside the platform FQDN in one entry", () => {
    const tlsFence = granted.policy.spec.validations.find((v) => v.expression.includes("spec.tls.all(t, has(t.hosts)"))!;
    expect(tlsFence.expression).toContain(`h == 'acme.${APEX}' || h == '${FQDN}'`);
    const ownEntry = granted.policy.spec.validations.find((v) => v.expression.includes("t.hosts.size() > 1"))!;
    // The isolation term pins the PLATFORM address alone: the granted fqdn may share nothing with it.
    expect(ownEntry.expression).toContain(`'acme.${APEX}' in t.hosts`);
    expect(ownEntry.expression).not.toContain(`'${FQDN}' in t.hosts`);
  });

  it("changes nothing else — the Service and Namespace clauses render exactly as without the grant", () => {
    expect(granted.policy.spec.validations.slice(3)).toEqual(policy.spec.validations.slice(3));
    expect(granted.binding).toEqual(binding);
  });
});

// The fence against the ADMISSION REQUEST a consumer sends. `evaluatesFor` implements the part of
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

type Rendered = ReturnType<typeof renderConsumerAdmissionPolicy>;

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

describe("the fence against the admission request a consumer sends", () => {
  const rendered = { policy, binding };

  it("EVALUATES for a foreign namespace name — the exact case the fence exists for", () => {
    // Consumer acme renders `kind: Namespace` named vault; ArgoCD applies it stamped with acme's
    // own Application. A policy skipped here admits the object, ArgoCD adopts the live platform
    // namespace, and dropping the file from a later commit prunes it off the cluster.
    const review = namespaceReview("vault", "acme-prod:/Namespace:/vault");
    expect(evaluatesFor(rendered, review), "the policy was SKIPPED for a foreign namespace name — the own-namespace clause can never fire").toBe(true);
  });

  it("DENIES the foreign namespace name with the own-namespace clause", () => {
    expect(admit(rendered, namespaceReview("vault", "acme-prod:/Namespace:/vault")).denied).toContain("a consumer may only create its own namespace acme");
  });

  it("admits the unit's own namespace", () => {
    expect(admit(rendered, namespaceReview("acme", "acme-prod:/Namespace:/acme"))).toEqual({ evaluated: true, denied: [] });
  });

  it("passes another actor's namespace through the CLAUSES, not around the policy", () => {
    // The platform's own namespaces carry no tracking-id; a neighbour unit's carries its own
    // Application's. Both pass on the ownership term inside the clause — evaluated, not skipped.
    expect(admit(rendered, namespaceReview("mongodb"))).toEqual({ evaluated: true, denied: [] });
    expect(admit(rendered, namespaceReview("bravo", "bravo-prod:/Namespace:/bravo"))).toEqual({ evaluated: true, denied: [] });
  });

  it("refuses every self-granted platform label on the unit's OWN namespace name", () => {
    // Each of these is a live grant, and each is written by the same one file in the unit's own
    // chart — `kind: Namespace, metadata: {name: acme, labels: {…}}`:
    //   platform/tenant-managed        binds the tenant-eso Vault role (a foreign tenant's crypto);
    //   hostyour.cloud/workload       binds the external-secrets role — the cluster mount's whole
    //                                  app tier: Mongo/Postgres root, the registry push credential;
    //   hostyour.cloud/build          binds build-eso, which holds the platform GitOps PATs;
    //   platform/redis-consumer        opens :6379 on the no-auth Redis every tenant IdP shares;
    //   pod-security enforce=privileged  runs a privileged pod on a shared node.
    for (const label of [
      { [TENANT_MANAGED_LABEL]: "true" },
      { "hostyour.cloud/workload": "true" },
      { "hostyour.cloud/build": "true" },
      { "platform/redis-consumer": "true" },
      { "pod-security.kubernetes.io/enforce": "privileged" },
    ]) {
      const review = namespaceReview("acme", "acme-prod:/Namespace:/acme", label);
      expect(admit(rendered, review).denied, `label ${JSON.stringify(label)} was admitted`).toHaveLength(1);
    }
  });

  it("admits the namespace metadata the platform itself stamps — the same admission request as the chart's", () => {
    // ArgoCD applies the managed namespace under THIS unit's tracking id, so the platform's own
    // managedNamespaceMetadata (consumers-appset.yaml) reaches this policy exactly like a chart
    // would. A fence that refused it would deadlock every consumer sync.
    const review = namespaceReview("acme", "acme-prod:/Namespace:/acme", {
      "pod-security.kubernetes.io/enforce": "restricted",
      "hostyour.cloud/consumer": "true",
      "hostyour.cloud/consumer-name": "acme",
      "platform/db-consumer": "true",
      // a label of the unit's own, in no platform namespace: its business, passed unread
      "acme.example.com/tier": "web",
    });
    expect(admit(rendered, review)).toEqual({ evaluated: true, denied: [] });
  });

  it("admits the redis reach label only where the registration attested the claim", () => {
    const claimed = renderConsumerAdmissionPolicy({ name: "acme", namespace: "acme", unitApex: APEX, argoAppName: ARGO_APP, services: ["mongodb", "redis"] });
    const review = namespaceReview("acme", "acme-prod:/Namespace:/acme", { "platform/redis-consumer": "true" });
    expect(admit(claimed, review)).toEqual({ evaluated: true, denied: [] });
    expect(admit(rendered, review).denied).toHaveLength(1);
  });

  it("still confines the namespaced kinds to the unit's own namespace", () => {
    const ingress = (namespace: string): Review => ({ resource: "ingresses", operation: "CREATE", namespace, object: { metadata: { name: "web" } } });
    expect(evaluatesFor(rendered, ingress("acme"))).toBe(true);
    expect(evaluatesFor(rendered, ingress("vault"))).toBe(false);
  });
});

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
