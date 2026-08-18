import { describe, it, expect } from "vitest";
import { renderBuildRbac, renderConsumerArgoSync, renderSmtpOpsGrant, renderTenantArgoSync, tenantSyncUnits, unitBuildNamespace, RELAY_NAMESPACE, EVENTLISTENER_SUBJECT, MANAGER_SUBJECT, BUILD_PIPELINE_SERVICE_ACCOUNT } from "./build-rbac.ts";
import { tenantApplicationSet } from "./tenant-fanout.ts";
import { CONSUMER_PROJECT_LABEL, TENANT_PROJECT_LABEL, type RoleManifest, type RoleBindingManifest } from "../../adapters/kube/port.ts";

/** The standing members the product under test declares — stated by the fixture, the way a real
 *  tenant's registration states its own. */
const TEST_MEMBERS = ["auth", "jobs", "report"];

// The three grants are what stands between a pushed deploy ref and a release that actually runs and
// syncs. They are also the only Roles a unit gets, so what they reach — and what they do NOT — is the
// whole of what its pipeline can do to the cluster.

const grants = (argoNamespace = "argocd"): { role: RoleManifest; binding: RoleBindingManifest }[] =>
  renderBuildRbac({ name: "example-auth", argoNamespace });

const byName = (name: string, argoNamespace = "argocd"): { role: RoleManifest; binding: RoleBindingManifest } =>
  grants(argoNamespace).find((g) => g.role.metadata.name === name)!;

describe("renderBuildRbac", () => {
  it("renders exactly three grants, each a Role plus the Binding that arms it", () => {
    const all = grants();
    expect(all.map((g) => g.role.metadata.name)).toEqual(["example-auth-build-eventlistener", "example-auth-build-manager-read", "example-auth-argo-sync"]);
    for (const { role, binding } of all) {
      expect(binding.roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role.metadata.name });
      expect(binding.metadata.namespace).toBe(role.metadata.namespace);
      // Both halves carry the Controller ownership label the writer guards on.
      expect(role.metadata.labels).toEqual({ [CONSUMER_PROJECT_LABEL.key]: CONSUMER_PROJECT_LABEL.value });
      expect(binding.metadata.labels).toEqual({ [CONSUMER_PROJECT_LABEL.key]: CONSUMER_PROJECT_LABEL.value });
    }
  });

  it("lets the shared EventListener create PipelineRuns in the unit's OWN build namespace, and nothing else", () => {
    const { role, binding } = byName("example-auth-build-eventlistener");
    expect(role.metadata.namespace).toBe(unitBuildNamespace("example-auth"));
    expect(role.metadata.namespace).toBe("example-auth-build");
    expect(role.rules).toEqual([{ apiGroups: ["tekton.dev"], resources: ["pipelineruns"], verbs: ["create"] }]);
    // The subject lives in the build plane's own namespace — a cross-namespace binding is the only
    // way to reach it, since the unit's AppProject forbids the unit from rendering one itself.
    expect(binding.subjects).toEqual([{ kind: "ServiceAccount", name: EVENTLISTENER_SUBJECT.name, namespace: EVENTLISTENER_SUBJECT.namespace }]);
  });

  it("lets the manager READ the unit's PipelineRuns — read only, because it has no task in the release cycle", () => {
    const { role, binding } = byName("example-auth-build-manager-read");
    expect(role.metadata.namespace).toBe("example-auth-build");
    expect(role.rules).toEqual([{ apiGroups: ["tekton.dev"], resources: ["pipelineruns"], verbs: ["get", "list", "watch"] }]);
    expect(role.rules[0]!.verbs).not.toContain("create");
    // The literals, not MANAGER_SUBJECT's own fields: comparing the rendering against the constant
    // it was rendered from is a comparison of a value with itself, and it held while the constant
    // named an account no chart renders. These two names are apps/manager/templates/
    // serviceaccount.yaml and apps/manager/app.yaml in hostyour-cloud, which this repo cannot read.
    expect(binding.subjects).toEqual([{ kind: "ServiceAccount", name: "manager", namespace: "manager" }]);
    expect(MANAGER_SUBJECT).toEqual({ namespace: "manager", name: "manager" });
  });

  it("scopes argo-sync to the unit's THREE Applications by name, in the ArgoCD namespace they live in", () => {
    const { role, binding } = byName("example-auth-argo-sync");
    expect(role.metadata.namespace).toBe("argocd");
    expect(role.rules[0]!.resourceNames).toEqual(["example-auth-dev", "example-auth-test", "example-auth-prod"]);
    expect(role.rules[0]!.apiGroups).toEqual(["argoproj.io"]);
    expect(role.rules[0]!.resources).toEqual(["applications"]);
    // The pipeline runs in the unit's build namespace, so that is where the subject lives.
    expect(binding.subjects).toEqual([{ kind: "ServiceAccount", name: BUILD_PIPELINE_SERVICE_ACCOUNT, namespace: "example-auth-build" }]);
  });

  it("keeps list and watch OUT of argo-sync — kube ignores resourceNames for them, so either would reach every Application", () => {
    const { role } = byName("example-auth-argo-sync");
    expect(role.rules[0]!.verbs).toEqual(["get", "patch"]);
    expect(role.rules[0]!.verbs).not.toContain("list");
    expect(role.rules[0]!.verbs).not.toContain("watch");
  });

  it("follows the unit to a slave's ArgoCD namespace — only the argo-sync grant moves, the build ones stay", () => {
    const all = grants("s1");
    expect(all.map((g) => g.role.metadata.namespace)).toEqual(["example-auth-build", "example-auth-build", "s1"]);
    expect(byName("example-auth-argo-sync", "s1").binding.metadata.namespace).toBe("s1");
  });

  // The two build-namespace grants exist once per UNIT (the namespace is stage-free) while argo-sync
  // exists once per stage, in the target cluster's own ArgoCD namespace. A teardown of one stage renders
  // the third grant ALONE, so it must be the very object renderBuildRbac puts in that slot.
  it("renders its argo-sync grant through renderConsumerArgoSync, so a one-stage teardown can render it alone", () => {
    for (const argoNamespace of ["argocd", "s1"]) {
      expect(renderConsumerArgoSync({ name: "example-auth", argoNamespace })).toEqual(byName("example-auth-argo-sync", argoNamespace));
    }
  });
});

// The tenant grant is the same mechanism over a fan-out: one Role naming the tenant's OWN member
// Applications, in the per-slave ArgoCD namespace they live in. Both tenants below sit in the SAME
// namespace, which is exactly why the names are spelled out — a rule without them would reach the
// neighbour's Applications and a release syncing one tenant would touch the other.
const TENANT = "zsjs023ctne0";
const NEIGHBOUR = "e2e8ymj86dk8";
const TENANT_APPS = [{ name: "erp" }, { name: "web" }];

const tenantGrant = (units: readonly string[] = ["example-platform", "example-auth"]) =>
  renderTenantArgoSync({ guid: TENANT, applications: tenantApplicationSet([...TEST_MEMBERS, ...TENANT_APPS.map((a) => a.name)], TENANT, "prod"), argoNamespace: "s1", units });

describe("renderSmtpOpsGrant", () => {
  // The permission a mail-queue dashboard needs, and it is not small: exec into the RELAY's pods.
  // Two properties carry the whole design, and each is one this repo got wrong somewhere before.
  const g = renderSmtpOpsGrant({ name: "example-post" });

  it("lands in the RELAY's namespace, not the unit's — that is the point of writing it here", () => {
    // A chart of the unit cannot grant itself anything in someone else's namespace, and the relay's
    // chart cannot name the unit. Only a writer that knows both can put this object where it belongs.
    expect(g.role.metadata.namespace).toBe(RELAY_NAMESPACE);
    expect(g.binding.metadata.namespace).toBe(RELAY_NAMESPACE);
    expect(g.binding.subjects).toEqual([{ kind: "ServiceAccount", name: "example-post", namespace: "example-post" }]);
  });

  it("carries the consumer ownership label on BOTH objects, so the offboard's delete reaches them", () => {
    // The writer only ever replaces or deletes what carries this label. An unlabelled Role in the
    // relay's namespace would outlive every consumer that ever claimed it — with pods/exec on it.
    for (const o of [g.role, g.binding]) {
      expect(o.metadata.labels?.[CONSUMER_PROJECT_LABEL.key]).toBe(CONSUMER_PROJECT_LABEL.value);
    }
  });

  it("grants reading and exec, and nothing that writes the relay's own configuration", () => {
    const byResource = Object.fromEntries(g.role.rules.map((r) => [r.resources.join(","), r.verbs]));
    expect(byResource["pods"]).toEqual(["get", "list"]);
    expect(byResource["pods/log"]).toEqual(["get"]);
    expect(byResource["pods/exec"]).toEqual(["create", "get"]);
    // No secrets, no configmaps, no deployments: a queue dashboard reads and execs, it does not
    // reconfigure the relay it is looking at.
    const reached = g.role.rules.flatMap((r) => r.resources);
    for (const forbidden of ["secrets", "configmaps", "deployments", "pods/portforward"]) {
      expect(reached).not.toContain(forbidden);
    }
  });

  it("is named per unit, so two claimants never collide on one object", () => {
    expect(g.role.metadata.name).toBe("example-post-smtp-ops");
    expect(renderSmtpOpsGrant({ name: "other-unit" }).role.metadata.name).toBe("other-unit-smtp-ops");
  });
});

describe("renderTenantArgoSync", () => {
  it("names every member Application of this tenant and nothing else — not a neighbour's, not another stage's", () => {
    const { role } = tenantGrant();
    expect(role.rules[0]!.resourceNames).toEqual([
      `${TENANT}-auth-prod`, `${TENANT}-jobs-prod`, `${TENANT}-report-prod`, `${TENANT}-erp-prod`, `${TENANT}-web-prod`,
    ]);
    // The tenant standing beside it in the same ArgoCD namespace: not one of its names is reachable.
    for (const app of tenantApplicationSet([...TEST_MEMBERS, "erp"], NEIGHBOUR, "prod")) {
      expect(role.rules[0]!.resourceNames).not.toContain(app);
    }
    // And nothing outside this tenant at this stage — every name carries the guid and the -prod suffix.
    for (const name of role.rules[0]!.resourceNames!) {
      expect(name.startsWith(`${TENANT}-`)).toBe(true);
      expect(name.endsWith("-prod")).toBe(true);
    }
  });

  it("arms the build pipeline of every unit that builds the tenant's images, and no other identity", () => {
    const { role, binding } = tenantGrant();
    expect(role.metadata.namespace).toBe("s1"); // the per-slave ArgoCD namespace, beside the Applications
    expect(binding.metadata.namespace).toBe("s1");
    expect(binding.roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: `${TENANT}-argo-sync` });
    // A tenant runs no release of its own, so the subjects are the releasing units' pipelines — the
    // SA every release PipelineRun runs as, in each unit's own build namespace.
    expect(binding.subjects).toEqual([
      { kind: "ServiceAccount", name: BUILD_PIPELINE_SERVICE_ACCOUNT, namespace: unitBuildNamespace("example-platform") },
      { kind: "ServiceAccount", name: BUILD_PIPELINE_SERVICE_ACCOUNT, namespace: unitBuildNamespace("example-auth") },
    ]);
    // Both halves carry the TENANT ownership label — the writer refuses to touch anything without one.
    expect(role.metadata.labels).toEqual({ [TENANT_PROJECT_LABEL.key]: TENANT_PROJECT_LABEL.value });
    expect(binding.metadata.labels).toEqual({ [TENANT_PROJECT_LABEL.key]: TENANT_PROJECT_LABEL.value });
  });

  it("keeps list and watch out, exactly like the consumer grant — resourceNames do not bind them", () => {
    expect(tenantGrant().role.rules[0]!.verbs).toEqual(["get", "patch"]);
  });

  it("renders name and namespace on their own, so a teardown can delete the grant without naming a unit", () => {
    const { role, binding } = renderTenantArgoSync({ guid: TENANT, applications: [], argoNamespace: "argocd", units: [] });
    expect([role.metadata.name, binding.metadata.name]).toEqual([`${TENANT}-argo-sync`, `${TENANT}-argo-sync`]);
    expect(binding.subjects).toEqual([]);
  });
});

describe("tenantSyncUnits", () => {
  // Which units may sync a tenant is DERIVED from what the tenant pulls: a build name is the flat
  // registry repository, so the pinned image names its builder. Nothing keeps a list of components.
  const attested = [
    { unit: "example-platform", build: "example-engine" },
    { unit: "example-platform", build: "example-ui" },
    { unit: "example-auth", build: "example-auth-backend" },
    { unit: "swissbookai", build: "swissbookai-api" },
  ];

  it("names the units behind the tenant's images, deduped and sorted", () => {
    const images = [{ repo: "example-engine" }, { repo: "example-ui" }, { repo: "example-auth-backend" }];
    expect(tenantSyncUnits(images, attested)).toEqual(["example-auth", "example-platform"]);
  });

  it("leaves out a unit that builds none of them — its release can bump no pin of this tenant", () => {
    expect(tenantSyncUnits([{ repo: "example-engine" }], attested)).toEqual(["example-platform"]);
    expect(tenantSyncUnits([], attested)).toEqual([]);
  });
});
