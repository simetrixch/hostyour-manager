import { describe, it, expect } from "vitest";
import { renderTenantAppProject } from "./appproject.ts";
import { CONSUMER_PROJECT_LABEL, TENANT_PROJECT_LABEL } from "../../adapters/kube/port.ts";

describe("renderTenantAppProject", () => {
  const CATALOG = "https://github.com/acme/acme-catalog.git";
  const PLATFORM = "https://github.com/simetrixch/hostyour-cloud.git";
  const GUID = "e2e8ymj86dk8";
  const render = (member: string) =>
    renderTenantAppProject({ guid: GUID, member, argoNamespace: "s1", catalogRepoUrl: CATALOG, platformRepoURL: PLATFORM, cluster: "s1" });
  const project = render("auth");

  it("names the project == namespace == <guid>-<member> and lives in the per-slave ArgoCD namespace", () => {
    expect(project.apiVersion).toBe("argoproj.io/v1alpha1");
    expect(project.kind).toBe("AppProject");
    expect(project.metadata.name).toBe("e2e8ymj86dk8-auth");
    expect(project.metadata.namespace).toBe("s1");
  });

  it("gives every member its OWN project, pairwise different and never the bare guid", () => {
    const names = ["auth", "jobs", "report", "erp", "web"].map((m) => render(m).metadata.name);
    expect(names).toEqual([
      "e2e8ymj86dk8-auth",
      "e2e8ymj86dk8-jobs",
      "e2e8ymj86dk8-report",
      "e2e8ymj86dk8-erp",
      "e2e8ymj86dk8-web",
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain(GUID);
  });

  it("carries the tenant ownership label (distinct from the consumer label)", () => {
    expect(project.metadata.labels).toEqual({ [TENANT_PROJECT_LABEL.key]: TENANT_PROJECT_LABEL.value });
    expect(project.metadata.labels).not.toHaveProperty(CONSUMER_PROJECT_LABEL.key);
  });

  it("allows catalog AND the platform repo — a member Application pulls its chart from one and its $values chain from the other", () => {
    // The whole list — so the consumer-scoped prometheus-community repo cannot appear here either.
    expect(project.spec.sourceRepos).toEqual([CATALOG, PLATFORM]);
  });

  it("pins a single destination to the tenant's OWN cluster by ArgoCD name + THAT MEMBER's namespace (never server '*')", () => {
    expect(project.spec.destinations).toEqual([{ name: "s1", namespace: "e2e8ymj86dk8-auth" }]);
    expect(project.spec.destinations[0]).not.toHaveProperty("server"); // name-pinned, not any-cluster
  });

  it("fences a member out of its SIBLINGS: its project permits its own namespace and no other", () => {
    const erp = render("erp");
    expect(erp.spec.destinations).toEqual([{ name: "s1", namespace: "e2e8ymj86dk8-erp" }]);
    expect(erp.spec.destinations.map((d) => d.namespace)).not.toContain("e2e8ymj86dk8-auth");
  });

  it("whitelists Namespace alone — the Tenant CR is the Manager's to write, never a chart's", () => {
    expect(project.spec.clusterResourceWhitelist).toEqual([{ group: "", kind: "Namespace" }]);
    expect(project.spec.clusterResourceWhitelist).not.toContainEqual({ group: "operator.hostyour.cloud", kind: "Tenant" });
  });

  it("keeps the same fence-4 self-escalation blacklist as the consumer project", () => {
    expect(project.spec.namespaceResourceBlacklist).toEqual([
      { group: "argoproj.io", kind: "Application" },
      { group: "argoproj.io", kind: "ApplicationSet" },
      { group: "argoproj.io", kind: "AppProject" },
      { group: "rbac.authorization.k8s.io", kind: "Role" },
      { group: "rbac.authorization.k8s.io", kind: "RoleBinding" },
    ]);
  });

  it("grants no roles", () => {
    expect(project.spec.roles).toEqual([]);
  });
});
