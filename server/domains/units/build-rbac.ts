// A unit's build RBAC — the three grants its release cycle needs, plus the ONE mail-ops grant a unit
// that attests `smtp-ops` gets. Two of the three build grants belong to the UNIT and the third to the
// unit AT ONE STAGE; the scopes are set out below, and calling the set "the per-unit build RBAC" is
// what made a one-stage teardown delete all three.
//
// WHO APPLIES WHAT, AND IT IS NOT ONE ANSWER ANY MORE. All three build grants are rendered from the
// registration since hostyour-cloud#174 — the two `<name>-build` ones by clusters/inventories/consumer-build
// in unit mode (under the names that chart already used, `eventlistener-create-pipelineruns` and
// `manager-read-pipelineruns`), and the argo-sync one by clusters/units/reconciler. So the onboard,
// the offboard and the purge write none of them, and renderBuildRbac/renderConsumerArgoSync keep ONE
// caller here: relocation-world-consumer.ts, which arms a TARGET cluster while the registration still
// points at the SOURCE and clears the source's argo-sync grant afterwards — two moments at which no
// chart can render either, because the ApplicationSets select on the registration's `cluster`.
//
// renderSmtpOpsGrant is the exception, and the reason is a destination rather than a preference: it
// lands in the relay's namespace ON THE MASTER, and the reconciler that manages a slave-hosted unit
// is registered for exactly one namespace, so it cannot reach `postfix` at all. The Manager is
// therefore still its only writer, with the onboard's provision-smtp-ops-grant and the removal run
// kinds' delete-smtp-ops-grant as its inverse.
//
// The three build grants, each a Role plus the Binding that arms it:
//
//   1. EventListener — create PipelineRuns in <name>-build. The webhook the unit's release ref fires
//      lands on the shared EventListener, which then has to create a PipelineRun in the unit's OWN
//      build namespace; without this grant the delivery is accepted and nothing runs.
//   2. Manager read — get/list/watch PipelineRuns in <name>-build, so the manager can watch a
//      release run it did not start. Read only: the manager has no task in the release cycle.
//   3. argo-sync — patch the unit's OWN Applications, in the ArgoCD namespace they live in. This is
//      what lets the release pipeline's last step tell ArgoCD to sync the bump it just committed.
//      Scoped by resourceNames to exactly <name>-dev/-test/-prod.
//
// The three do NOT share a scope, which is what makes renderConsumerArgoSync a renderer of its own.
// Grants 1 and 2 live in `<name>-build`, and a build is stage-free — one namespace per unit, one image
// per release — so a unit deployed at two stages has ONE of each. Grant 3 lives in the target cluster's
// ArgoCD namespace, and a cluster carries exactly one stage, so that one exists per stage. A teardown
// that removes 1 and 2 while another stage stands leaves that stage unable to release.
//
// A TENANT gets one more grant of the same kind, rendered here as well (renderTenantArgoSync): its
// member Applications need the same sync, but a tenant runs no release of its own, so the grant arms
// the build pipelines of the units that BUILD the images its charts pin.
//
// Pure: no IO. The writer (adapters/kube) applies what this renders.
import { CONSUMER_PROJECT_LABEL, TENANT_PROJECT_LABEL, type BuildRbacGrant, type RoleBindingManifest, type RoleManifest } from "../../adapters/kube/port.ts";
import { STAGE } from "../../../shared/enums.ts";
import { consumerArgoAppName } from "../../../shared/consumer.ts";

/** The shared EventListener's ServiceAccount — the identity that creates a PipelineRun when a unit's
 *  deploy ref is pushed. It lives in the build plane's own namespace, not the unit's, which is why the
 *  grant has to be a RoleBinding across namespaces rather than a Role the unit's chart could carry. */
export const EVENTLISTENER_SUBJECT = { namespace: "image-builder", name: "eventlistener-sa" } as const;

/** This process's own ServiceAccount — the identity behind every kube read it makes. Both halves
 *  are the chart's: apps/manager/templates/serviceaccount.yaml renders the account, and
 *  apps/manager/app.yaml names the namespace it is installed into. */
export const MANAGER_SUBJECT = { namespace: "manager", name: "manager" } as const;

/** The ServiceAccount every PipelineRun in a unit's build namespace runs under. One per build
 *  namespace, so a unit's pipeline holds exactly this unit's grants and no other's. */
export const BUILD_PIPELINE_SERVICE_ACCOUNT = "pipeline-sa";

/** The suffix the build namespace is derived with. Exported on its own because the name gate
 *  (gates/compose.ts) refuses any unit NAME ending in it: such a name IS some unit's build
 *  namespace, so admitting it would pin the unit's AppProject into that namespace. */
export const BUILD_NAMESPACE_SUFFIX = "-build";

/** The namespace the platform's mail relay runs in — a PLATFORM app of this base
 *  (hostyour-cloud/clusters/inventories/postfix, its own catalog element), not a unit of any
 *  installation, so naming it here is the same kind of fact as `image-builder` and `manager` above. */
export const RELAY_NAMESPACE = "postfix";

/** The unit's build namespace — where its pipeline, its PipelineRuns and its build credentials live. */
export function unitBuildNamespace(name: string): string {
  return `${name}${BUILD_NAMESPACE_SUFFIX}`;
}

/** One Role + the RoleBinding that binds it to the given ServiceAccounts, both in `namespace`. The
 *  ownership label is the writer's guard: it only ever replaces or deletes an object carrying one, so
 *  a consumer's grants are labeled as a consumer's and a tenant's as a tenant's. */
function grant(input: {
  name: string;
  namespace: string;
  label: { key: string; value: string };
  rules: RoleManifest["rules"];
  subjects: readonly { namespace: string; name: string }[];
}): BuildRbacGrant {
  const labels = { [input.label.key]: input.label.value };
  const role: RoleManifest = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: { name: input.name, namespace: input.namespace, labels },
    rules: input.rules,
  };
  const binding: RoleBindingManifest = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: input.name, namespace: input.namespace, labels },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: input.name },
    subjects: input.subjects.map((s) => ({ kind: "ServiceAccount" as const, name: s.name, namespace: s.namespace })),
  };
  return { role, binding };
}

/**
 * Render a unit's build grants. `argoNamespace` is where the unit's Application CRs live — the
 * master's "argocd" or a slave's per-slave ArgoCD namespace — so the argo-sync grant lands beside the
 * Applications it names rather than in the build namespace. ABSENT for a build-only unit: it has no
 * Applications, so an argo-sync grant would name objects that can never exist; only the two
 * build-namespace grants (the webhook's create, the manager's watch) are rendered.
 */
export function renderBuildRbac(input: { name: string; argoNamespace?: string }): BuildRbacGrant[] {
  const buildNs = unitBuildNamespace(input.name);
  const grants = [
    grant({
      name: `${input.name}-build-eventlistener`,
      namespace: buildNs,
      label: CONSUMER_PROJECT_LABEL,
      rules: [{ apiGroups: ["tekton.dev"], resources: ["pipelineruns"], verbs: ["create"] }],
      subjects: [EVENTLISTENER_SUBJECT],
    }),
    grant({
      name: `${input.name}-build-manager-read`,
      namespace: buildNs,
      label: CONSUMER_PROJECT_LABEL,
      rules: [{ apiGroups: ["tekton.dev"], resources: ["pipelineruns"], verbs: ["get", "list", "watch"] }],
      subjects: [MANAGER_SUBJECT],
    }),
  ];
  if (input.argoNamespace !== undefined) grants.push(renderConsumerArgoSync({ name: input.name, argoNamespace: input.argoNamespace }));
  return grants;
}

/**
 * ONE unit's mail-OPS grant, in the RELAY's namespace: read its pods, read their logs, and exec into
 * them — what a queue dashboard needs to run postqueue/postsuper and show what the relay did with a
 * message. Rendered ONLY for a unit whose stage registration attests `smtp-ops`.
 *
 * Written by the Manager rather than by the relay's chart, for a reason the relay cannot solve: a
 * RoleBinding names a concrete ServiceAccount, so a chart carrying it would have to know which unit
 * of which installation runs the dashboard — the very name this ticket removes. A namespace LABEL
 * cannot stand in either: labels select namespaces for a NetworkPolicy, and RBAC binds identities.
 *
 * Role AND binding, both under the consumer ownership label, so the offboard's delete takes the
 * permission away with the unit. Left to the chart, the Role would outlive every consumer that ever
 * claimed it, in the namespace of the relay itself.
 */
export function renderSmtpOpsGrant(input: { name: string }): BuildRbacGrant {
  return grant({
    name: `${input.name}-smtp-ops`,
    namespace: RELAY_NAMESPACE,
    label: CONSUMER_PROJECT_LABEL,
    rules: [
      { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
      { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
      { apiGroups: [""], resources: ["pods/exec"], verbs: ["create", "get"] },
    ],
    subjects: [{ namespace: input.name, name: input.name }],
  });
}

/**
 * ONE unit's argo-sync grant, on its own — because its SCOPE differs from the two build-namespace
 * grants it is rendered beside. The ArgoCD namespace belongs to the unit's TARGET cluster (the master's
 * "argocd", or a slave's per-slave one), and a cluster carries exactly one stage, so a unit deployed at
 * two stages has two of these, one per cluster, while it has only one `<name>-build`. A teardown of ONE
 * stage therefore renders this alone: the grant of the stage that is going, without touching what the
 * unit's surviving stages build with.
 */
export function renderConsumerArgoSync(input: { name: string; argoNamespace: string }): BuildRbacGrant {
  return grant({
    name: `${input.name}-argo-sync`,
    namespace: input.argoNamespace,
    label: CONSUMER_PROJECT_LABEL,
    rules: [
      {
        apiGroups: ["argoproj.io"],
        resources: ["applications"],
        // Every Application this unit can ever have, named outright. The ArgoCD namespace holds
        // every unit's Applications, so without resourceNames this grant would reach all of them.
        resourceNames: STAGE.map((stage) => consumerArgoAppName(input.name, stage)),
        // list and watch are deliberately absent: kube ignores resourceNames for those two verbs,
        // so granting either would silently widen this Role back to every Application in the
        // namespace. A sync is a read plus a patch of the named object, which needs neither.
        verbs: ["get", "patch"],
      },
    ],
    subjects: [{ namespace: unitBuildNamespace(input.name), name: BUILD_PIPELINE_SERVICE_ACCOUNT }],
  });
}

/**
 * ONE tenant's argo-sync grant — get/patch on exactly that tenant's OWN member Applications, in the
 * ArgoCD namespace they live in. Applied beside the member AppProjects and deleted with them, and the
 * one thing that lets a release deploy into a tenant NOW instead of on ArgoCD's next poll.
 *
 * It differs from a consumer's argo-sync grant in WHO it arms. A tenant runs no release of its own:
 * its members deploy platform charts, and a member Application moves when the release of the unit
 * that BUILDS one of its images bumps the pin. The subjects are therefore those units' build
 * pipelines — `pipeline-sa` in each `<unit>-build`, the identity every release PipelineRun runs as —
 * and a unit that builds none of this tenant's images is never named, so its release cannot reach
 * this tenant. `units` comes from tenantSyncUnits below.
 *
 * `applications` are the member Application names, which only tenant-fanout produces. Naming them
 * outright is what keeps one tenant off another's Applications: the ArgoCD namespace holds every
 * tenant's, and a rule without resourceNames would reach all of them.
 *
 * A DELETE matches on the object names alone, so a teardown renders this with neither Application
 * nor unit.
 */
export function renderTenantArgoSync(input: {
  guid: string;
  applications: readonly string[];
  argoNamespace: string;
  units: readonly string[];
}): BuildRbacGrant {
  return grant({
    name: `${input.guid}-argo-sync`,
    namespace: input.argoNamespace,
    label: TENANT_PROJECT_LABEL,
    rules: [
      {
        apiGroups: ["argoproj.io"],
        resources: ["applications"],
        resourceNames: [...input.applications],
        // list and watch stay out for the same reason as in the consumer grant above: kube ignores
        // resourceNames for those two verbs.
        verbs: ["get", "patch"],
      },
    ],
    subjects: input.units.map((unit) => ({ namespace: unitBuildNamespace(unit), name: BUILD_PIPELINE_SERVICE_ACCOUNT })),
  });
}

/** WHICH units may sync a tenant: those that ATTEST a build name the tenant's own images carry. A
 *  build name IS the flat registrations repository and the build-name uniqueness gate lets exactly one unit
 *  claim it, so a pinned image names its builder outright — the set is derived from what the tenant
 *  pulls, never kept as a list of components. `images` are the tenant's required images, whose `repo`
 *  is that same flat build name (requiredImagesFrom strips the registry host), `attested`
 *  the unit/build pairs from the registration branch. Deduped and sorted, so re-provisioning a tenant
 *  writes the same subjects in the same order. */
export function tenantSyncUnits(
  images: readonly { repo: string }[],
  attested: readonly { unit: string; build: string }[],
): string[] {
  const pinned = new Set(images.map((image) => image.repo));
  const units = new Set<string>();
  for (const { unit, build } of attested) if (pinned.has(build)) units.add(unit);
  return [...units].sort();
}
