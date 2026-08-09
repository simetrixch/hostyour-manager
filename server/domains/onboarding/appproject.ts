import { CONSUMER_PROJECT_LABEL, TENANT_PROJECT_LABEL, type AppProjectManifest } from "../../adapters/kube/port.ts";
import { memberAppProject, memberNamespace } from "./tenant-fanout.ts";

/** The prometheus-community Helm chart repository. A consumer that
 *  claims `postgresql` gets a platform-rendered per-consumer PostgreSQL whose chart pulls its metrics
 *  exporter (prometheus-postgres-exporter) as a Helm dependency from this repo, so ArgoCD's
 *  `helm dependency build` fetches from it — which the consumer's AppProject sourceRepos must permit or
 *  the sync is rejected. Allowed for EVERY consumer's project (an allowlist entry creates nothing; the
 *  postgres source itself is rendered only when the consumer claims postgresql), so a consumer that
 *  claims no postgresql is unaffected. */
export const PROMETHEUS_COMMUNITY_HELM_REPO = "https://prometheus-community.github.io/helm-charts";

// The per-UNIT isolation AppProject renderer.
// One template, two formats: renderConsumerAppProject (one per consumer) and renderTenantAppProject
// (one per tenant MEMBER). Pure: no IO — the writer (adapters/kube/kube.ts) applies what this
// renders. Rendered before the registration is committed, because the generated Application references
// .spec.project == the unit's isolation project and ArgoCD rejects an Application whose project is
// absent. Both renderers hold the identity law (name == namespace == the unit, where a tenant's unit
// is ONE member) and the fence-4 self-escalation blacklist; they differ in ownership label,
// sourceRepos and the destination pin (consumer: server "*", tenant: name <cluster> — its ONE slave).

/** Render a consumer's isolation AppProject.
 *  name == namespace == consumerName; sourceRepos = the consumer's own repo PLUS the platform GitOps
 *  repo (hostyour-cloud) — the generated multi-source Application pulls its chart from the consumer's repo
 *  but its `$values` chain from hostyour-cloud, so both must be allowed; the
 *  appset TEMPLATE (not the pointer) pins the hostyour-cloud paths, so this cannot let the consumer
 *  redirect the chart source. destinations pin the namespace (server "*": the appset chooses the
 *  cluster, the namespace is the isolation); clusterResourceWhitelist = Namespace only; the argo/rbac
 *  kinds AND Secret are blacklisted so a chart cannot create Applications/AppProjects/Roles/RoleBindings
 *  or write a Secret past ESO. No finalizer. */
export function renderConsumerAppProject(input: { name: string; namespace: string; repoURL: string; platformRepoURL: string; argoNamespace: string }): AppProjectManifest {
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "AppProject",
    metadata: { name: input.name, namespace: input.argoNamespace, labels: { [CONSUMER_PROJECT_LABEL.key]: CONSUMER_PROJECT_LABEL.value } },
    spec: {
      description: `Per-consumer isolation project for ${input.name} (hostyour-cloud onboarding).`,
      // The consumer's own chart repo + the platform GitOps repo (hostyour-cloud: the Application's
      // $values chain and — when postgresql is claimed — the per-consumer PostgreSQL source) + the
      // prometheus-community Helm repo the postgres chart's exporter dependency is pulled
      // from. The appset TEMPLATE pins the hostyour-cloud paths, so allowing the repo here cannot
      // let the consumer redirect the chart source.
      sourceRepos: [input.repoURL, input.platformRepoURL, PROMETHEUS_COMMUNITY_HELM_REPO],
      destinations: [{ server: "*", namespace: input.namespace }],
      clusterResourceWhitelist: [{ group: "", kind: "Namespace" }],
      namespaceResourceBlacklist: [
        { group: "argoproj.io", kind: "Application" },
        { group: "argoproj.io", kind: "ApplicationSet" },
        { group: "argoproj.io", kind: "AppProject" },
        { group: "rbac.authorization.k8s.io", kind: "Role" },
        { group: "rbac.authorization.k8s.io", kind: "RoleBinding" },
        // ESO is the ONLY writer of a Secret in a consumer namespace. A chart that could apply its own
        // would put crypto material in git, and would also let it overwrite a Secret ESO materializes
        // from Vault — the value the workload then reads would be the chart's, not the platform's.
        { group: "", kind: "Secret" },
      ],
      roles: [],
    },
  };
}

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
 *  Two deltas from renderConsumerAppProject: the ownership label, and the destination pin
 *  `name: <cluster>` (the ArgoCD-registered slave name, == the registration's cluster field) instead
 *  of the consumer's `server: "*"` — a tenant runs on exactly ONE cluster, so its projects only permit
 *  deploys to that cluster (a redirected/hand-edited Application targeting any other cluster is
 *  rejected by ArgoCD). Namespace is the only cluster-scoped kind permitted: ArgoCD creates the member
 *  namespace itself (CreateNamespace + managedNamespaceMetadata), and the tenant's cluster-scoped
 *  crypto entry is written by the Controller into Vault, never by a chart. That Namespace grant is
 *  fenced by the member's own ValidatingAdmissionPolicy (renderTenantMemberAdmissionPolicy,
 *  admission-policy.ts), applied beside this project and deleted with it: the member may create only
 *  the namespace it IS, carrying no platform label beyond the pairs the tenant ApplicationSets
 *  stamp — so cross-tenant namespace safety no longer rests on the sole-renderer property alone
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
