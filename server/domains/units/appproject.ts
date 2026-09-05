import { TENANT_PROJECT_LABEL, type AppProjectManifest } from "../../adapters/kube/port.ts";
import { memberAppProject, memberNamespace } from "./tenant-fanout.ts";

// The per-TENANT-MEMBER isolation AppProject renderer. Pure: no IO — the writer
// (adapters/kube/kube.ts) applies what this renders. A unit's project stands before its Application
// can sync, because that Application references .spec.project == the unit's isolation project and
// ArgoCD rejects an Application whose project is absent.
//
// A CONSUMER'S IS NOT RENDERED HERE ANY MORE. hostyour-cloud's clusters/units/reconciler renders it
// from registrations/<name>/<stage>.yaml (hostyour-cloud#174), and hostyour-manager#113 deleted the
// last writer this repository had — relocation's provision-target, which used to arm a target cluster
// while the registration still named the source. A relocation now repoints the registration and lets
// the target's own reconciler render the project, exactly as an onboard does.
//
// renderTenantAppProject stays because nothing renders a tenant's per-MEMBER objects out of
// registrations/<guid>/…, so the Manager is still their only writer. It holds the identity law
// (name == namespace == the unit, where a tenant's unit is ONE member) and the fence-4
// self-escalation blacklist.

/** Render ONE tenant MEMBER's isolation AppProject.
 *  name == namespace == <guid>-<member>: a tenant holds several namespaces and
 *  several AppProjects, one pair per member, and each pair fences exactly one member — so a member's
 *  Application can deploy into its own namespace and nowhere else, not even into a sibling member of
 *  the same tenant.
 *
 *  sourceRepos = catalog (where every tenant chart lives) PLUS the platform GitOps repo
 *  (hostyour-cloud): the generated member Application is multi-source — it pulls its chart from
 *  catalog but its `$values` chain from hostyour-cloud — so both must be allowed or the sync is
 *  rejected. The appset TEMPLATE (not the registration) pins the hostyour-cloud paths.
 *
 *  Two deltas from the CONSUMER project clusters/units/reconciler renders: the ownership label, and
 *  the destination pin `name: <cluster>` (the ArgoCD-registered slave name, == the registration's
 *  cluster field) instead of the consumer's `server: "*"` — a tenant runs on exactly ONE cluster, so its projects only permit
 *  deploys to that cluster (a redirected/hand-edited Application targeting any other cluster is
 *  rejected by ArgoCD). Namespace is the only cluster-scoped kind permitted: ArgoCD creates the member
 *  namespace itself (CreateNamespace + managedNamespaceMetadata), and the tenant's cluster-scoped
 *  crypto entry is written by the Manager into Vault, never by a chart. That Namespace grant is
 *  fenced by the member's own ValidatingAdmissionPolicy (renderTenantMemberAdmissionPolicy,
 *  admission-policy.ts), applied beside this project and deleted with it: the member may create only
 *  the namespace it IS, carrying no platform label beyond the pairs the tenant ApplicationSets
 *  stamp — so cross-tenant namespace safety does not rest on the sole-renderer property alone
 *  (the platform renders the fan-out; the tenant never authors these). Same fence-4 blacklist so a
 *  tenant chart can never mint an Application/AppProject/Role/RoleBinding. */
export function renderTenantAppProject(input: { guid: string; member: string; argoNamespace: string; catalogRepoUrl: string; platformRepoURL: string; cluster: string }): AppProjectManifest {
  // Never hand-rolled — tenant-fanout is the source of truth for every tenant name.
  const name = memberAppProject(input.guid, input.member);
  const namespace = memberNamespace(input.guid, input.member);
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "AppProject",
    metadata: { name, namespace: input.argoNamespace, labels: { [TENANT_PROJECT_LABEL.key]: TENANT_PROJECT_LABEL.value } },
    spec: {
      description: `Per-member isolation project for tenant ${input.guid} member "${input.member}" (hostyour-cloud onboarding).`,
      sourceRepos: [input.catalogRepoUrl, input.platformRepoURL],
      destinations: [{ name: input.cluster, namespace }],
      clusterResourceWhitelist: [{ group: "", kind: "Namespace" }],
      namespaceResourceBlacklist: [
        { group: "argoproj.io", kind: "Application" },
        { group: "argoproj.io", kind: "ApplicationSet" },
        { group: "argoproj.io", kind: "AppProject" },
        { group: "rbac.authorization.k8s.io", kind: "Role" },
        { group: "rbac.authorization.k8s.io", kind: "RoleBinding" },
      ],
      roles: [],
    },
  };
}
