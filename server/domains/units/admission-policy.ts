// The per-consumer ADMISSION boundary — a ValidatingAdmissionPolicy plus its Binding. The AppProject
// fences what a unit may SUBMIT to ArgoCD (source repos, destination namespace, forbidden kinds);
// this fences what the resulting objects may SAY.
//
// A CONSUMER'S IS RENDERED FROM ITS REGISTRATION and not applied by the onboard any more: the six CEL
// clauses below were moved into hostyour-cloud's clusters/units/admissionpolicy chart character for
// character (hostyour-cloud#174), and that chart is what stands on the unit's TARGET cluster.
// renderConsumerAdmissionPolicy keeps ONE caller here, relocation-world-consumer.ts's provisionTarget,
// which arms a target cluster while the registration still names the source — the moment at which no
// chart can render it. renderTenantMemberAdmissionPolicy has no chart at all behind it: nothing
// renders registrations/<guid>/…, so the Manager is still the only writer of a tenant's. Together they hold regardless of what the unit deploys, which is what
// makes a per-release check unnecessary — and it is why the gates can stop asking these three
// questions at plan time.
//
// Three clauses, one per resource, and each one is a whole answer:
//   Ingress   — every rule's FQDN is one the platform GRANTED: `<name>.<unitApex>` always, plus the
//               unit's attested `fqdn` where its stage registration carries one (the onboard run kind
//               writes it there after gate G19 refused every name the platform already serves — the
//               policy renders from that attested value, never from the manifest). NOT `*.<name>`:
//               the platform's DNS carries one record per unit, so no resolver exists for a
//               sub-host. A consumer that ever needs sub-hosts gets an extension of THIS policy and
//               a wildcard record together. spec.tls is fenced with the same granted set — a tls
//               host drives an ACME order against the shared cluster-issuer, so an unfenced one
//               would order certificates for arbitrary names — and the platform address must stand
//               in a tls entry of its OWN: cert-manager builds one Certificate per entry and an
//               ACME order is atomic, so a granted domain whose DNS points elsewhere would
//               otherwise block the renewal of the unit's platform certificate.
//   Service   — type ClusterIP only. A LoadBalancer or NodePort reaches past the ingress the host rule
//               just pinned, and past the network policy that follows the namespace.
//   Namespace — a unit may only create the namespace it IS, and its labels may say nothing in the
//               platform's own label namespaces beyond what the platform itself stamps on it. The
//               second half is what keeps a namespace label from being a self-service grant: Vault
//               binds three of its ESO roles by a namespace label selector
//               (hostyour-cloud/base/lib/seed-vault.sh — `external-secrets` on
//               `hostyour.cloud/workload`, `tenant-eso-<stage>` on `platform/tenant-managed`,
//               `build-eso` on `hostyour.cloud/build`), Calico admits the no-auth Redis by
//               `platform/redis-consumer` (hostyour-cloud/apps/redis/templates/networkpolicy.yaml),
//               and the API server reads pod security off `pod-security.kubernetes.io/*`. A unit's
//               chart renders Namespace objects of its own — the AppProject whitelists that
//               cluster-scoped kind so ArgoCD can create the destination namespace at all — so
//               every one of those labels would otherwise be the unit's to write on itself: a
//               ServiceAccount named `external-secrets-sa` beside a self-written
//               `hostyour.cloud/workload` label reads the whole app tier of the cluster's Vault
//               mount, and a self-written `pod-security.kubernetes.io/enforce: privileged` runs a
//               privileged pod on a shared node.
//
// The Namespace clause is the one that dictates HOW the policy is scoped. A Binding's
// namespaceSelector is evaluated, for an object that IS a Namespace, against the OBJECT'S OWN
// labels — the API server stamps `kubernetes.io/metadata.name` on every namespace — so a selector
// pinned to the unit's name would SKIP every foreign namespace name, and the clause that refuses a
// foreign name could never fire. The scope therefore lives in the policy's own matchConditions
// (a false condition skips the request — scope, not verdict): namespaced kinds are confined to the
// unit's namespace by `request.namespace`, while every Namespace admission on the cluster is
// evaluated. The reach limiter for those is the ArgoCD TRACKING ID: ArgoCD stamps
// `argocd.argoproj.io/tracking-id: <app>:<group>/<kind>:<ns>/<name>` on everything it applies, so the
// expression constrains exactly the objects THIS unit's Application owns and passes everything else
// through untouched.
//
// The TENANT MEMBER boundary is the Namespace clause of this same mechanism with the tenant's own
// granted set (renderTenantMemberAdmissionPolicy, below): a member's chart lives in catalog and
// is the platform's own, so its Ingress hosts and Service types are not fenced here — but its
// AppProject whitelists the cluster-scoped Namespace kind exactly as a consumer's does, so a chart
// change that rendered a Namespace with `hostyour.cloud/workload: "true"` would bind the strongest
// ESO role on the slave. The two renderers share the Namespace clauses (namespaceValidations), one
// mechanism with two granted sets, so the fences cannot drift apart.
//
// Boundary: a pure domain module — it renders manifests and reads YAML text, no IO. The writer
// (adapters/kube) applies what this returns.
import { parse as parseYaml } from "yaml";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";
import type { Stage } from "../../../shared/enums.ts";
import { CONSUMER_PROJECT_LABEL, TENANT_PROJECT_LABEL, type AdmissionPolicyBindingManifest, type AdmissionPolicyManifest, type AdmissionValidation } from "../../adapters/kube/port.ts";
import { memberApplication, memberNamespace } from "./tenant-fanout.ts";
import { errValidation } from "../../kernel/errors.ts";

/** The annotation ArgoCD stamps on every object it applies. Its value starts with the Application's
 *  own name, which is what makes "does this unit own the object" answerable inside a CEL expression. */
const TRACKING_ID = "argocd.argoproj.io/tracking-id";

/** The label that marks a namespace as belonging to the TENANT fan-out — the binding of the
 *  `tenant-eso-<stage>` Vault role. Exported for the tenant fan-out, which is its one writer; a
 *  consumer namespace can never carry it, because `platform/` is a reserved label namespace below. */
export const TENANT_MANAGED_LABEL = "platform/tenant-managed";

/** The label namespaces the PLATFORM decides on, and which a unit's own Namespace object — consumer
 *  or tenant member — may therefore not write into freely. `hostyour.cloud/` and `platform/` are the two prefixes the
 *  platform's Vault role selectors, network policies and ApplicationSets key on;
 *  `pod-security.kubernetes.io/` is the API server's own Pod Security Admission surface. Everything
 *  outside these three is the unit's own business and passes unread.
 *
 *  `kubernetes.io/` is deliberately NOT here: the API server's namespace-label mutator stamps
 *  `kubernetes.io/metadata.name` on every namespace before this policy is evaluated, so reserving
 *  that prefix would refuse every namespace including the unit's own. */
const RESERVED_LABEL_PREFIXES: readonly string[] = ["hostyour.cloud/", "platform/", "pod-security.kubernetes.io/"];

/** The policy (and binding) name of one unit — `consumer-<name>`, prefixed so it can never collide
 *  with a platform-wide policy and so an operator reads the owner off the name. */
export function consumerAdmissionPolicyName(consumerName: string): string {
  return `consumer-${consumerName}`;
}

/** The policy (and binding) name of one tenant MEMBER — `tenant-<guid>-<member>`, one policy per
 *  member beside its AppProject. The `tenant-` prefix keeps it apart from every `consumer-<name>`
 *  and from the platform-wide policies (consumer-build-namespace-label); the body is the member
 *  namespace itself, never hand-composed, so an operator reads the owner off the name. */
export function tenantMemberAdmissionPolicyName(guid: string, member: string): string {
  return `tenant-${memberNamespace(guid, member)}`;
}

/** "This unit owns the object under review" — false for anything ArgoCD did not stamp for this
 *  unit's Application, which is how a cluster-scoped rule stays scoped to one unit. */
function ownedByUnitExpr(argoAppName: string): string {
  return `has(object.metadata.annotations) && '${TRACKING_ID}' in object.metadata.annotations && object.metadata.annotations['${TRACKING_ID}'].startsWith('${argoAppName}:')`;
}

/** The TWO Namespace clauses both boundaries carry — a unit may only create the namespace it IS, and
 *  its labels may say nothing under the reserved prefixes beyond the value-exact pairs the platform
 *  stamps. ONE builder, so the consumer and the tenant-member fence are one mechanism with two
 *  granted sets and can never drift apart. `subject` is the unit word the refusal names ("a
 *  consumer" / "a tenant member"). The label fence is two CEL terms over one label key `k`: is the
 *  key in a reserved label namespace at all, and — if it is — is it one of the granted pairs. Both
 *  sides of every pair come from validated grammars (the consumer name, the guid alphabet, a fixed
 *  service vocabulary), so neither can escape the single-quoted CEL literals. */
function namespaceValidations(input: {
  subject: string;
  namespace: string;
  argoAppName: string;
  granted: ReadonlyArray<readonly [string, string]>;
}): AdmissionValidation[] {
  const ownedByUnit = ownedByUnitExpr(input.argoAppName);
  const reservedKey = RESERVED_LABEL_PREFIXES.map((p) => `k.startsWith('${p}')`).join(" || ");
  const grantedPair = input.granted.map(([key, value]) => `(k == '${key}' && object.metadata.labels[k] == '${value}')`).join(" || ");
  return [
    {
      expression: `request.resource.resource != 'namespaces' || !(${ownedByUnit}) || object.metadata.name == '${input.namespace}'`,
      message: `${input.subject} may only create its own namespace ${input.namespace}`,
    },
    {
      // ONE clause for the whole class, not one per label: a namespace label is how the platform
      // binds Vault roles, admits network reach and sets pod security, so a unit's own Namespace
      // object is held to the exact pairs the platform stamps and refused anything else under the
      // reserved prefixes.
      expression: `request.resource.resource != 'namespaces' || !(${ownedByUnit}) || !has(object.metadata.labels) || object.metadata.labels.all(k, !(${reservedKey}) || ${grantedPair})`,
      message:
        `${input.subject} namespace may carry no label under ${RESERVED_LABEL_PREFIXES.join(", ")} beyond the ones the platform stamps on it ` +
        `(${input.granted.map(([k, v]) => `${k}=${v}`).join(", ")}) — those label namespaces bind Vault roles, admit network reach and set pod security, so a self-written one is a self-granted permission`,
    },
  ];
}

/** The ONE `global.unitApex` the layered cluster values chain resolves to — the public apex a unit's
 *  address is composed under (`<name>.<unitApex>`). The chain is read in LAYERING order and the last
 *  file that states the key wins, exactly as helm layers it, so a cluster's own `installation/profile.yaml`
 *  overrides the platform defaults. A chain that states it nowhere is a VALIDATION error naming the
 *  files that were read: rendering the host rule against a guessed apex would fence the unit off its
 *  own ingress. */
export function unitApexFromChain(files: readonly ClusterValueFile[]): string {
  let found: string | null = null;
  for (const file of files) {
    const parsed: unknown = parseYaml(file.content);
    const apex = (parsed as { global?: { unitApex?: unknown } } | null)?.global?.unitApex;
    if (typeof apex === "string" && apex.length > 0) found = apex;
  }
  if (found === null) {
    throw errValidation(
      `no global.unitApex in the cluster values chain (${files.map((f) => f.path).join(", ")}) — a unit's public host is <name>.<unitApex>, so the admission policy cannot be rendered without it`,
    );
  }
  return found;
}

/** The label pairs the platform itself puts on a consumer namespace — the ONLY values admitted under
 *  the reserved prefixes above. They are the managedNamespaceMetadata of the consumers
 *  ApplicationSet (hostyour-cloud/argocd/<stage>/apps/consumers-appset.yaml): ArgoCD applies the
 *  managed namespace under this unit's own tracking id, so the platform's write and the unit's chart
 *  are the same admission request to this policy and the pairs have to be admitted by value.
 *
 *  `platform/redis-consumer` is in the set only where the stage registration ATTESTS `redis` in
 *  services[] — the same condition the ApplicationSet's templatePatch stamps it under. Redis runs
 *  without authentication, so reach to :6379 IS the grant, and a unit that never claimed it must not
 *  be able to write itself into the NetworkPolicy's selector.
 *
 *  `platform/postfix-consumer` follows the same rule for the same reason: the platform relay
 *  accepts mail on :587 without authenticating the sender, so reach IS the grant there too. The
 *  relay's NetworkPolicy (hostyour-cloud/clusters/inventories/postfix/templates/networkpolicy.yaml) admits this label
 *  and no namespace NAME, which is what lets the cloud base carry a relay without knowing which unit
 *  of which installation sends through it. */
/** The pair that marks a namespace as a consumer's, and the selector that finds every one of them on a
 *  cluster. Declared here because this file is where the platform's own namespace labels are authored
 *  (grantedNamespaceLabels below uses it), so the mark and the search cannot drift apart: a scan asking
 *  the cluster "which namespaces are consumers?" has to ask for the label the platform actually stamps.
 *  Same key/value as CONSUMER_PROJECT_LABEL, which marks the AppProject — a different object, so the
 *  two constants stay separate rather than one being read as the other. */
export const CONSUMER_NAMESPACE_LABEL = { key: "hostyour.cloud/consumer", value: "true" } as const;
export const consumerNamespaceSelector = (): string => `${CONSUMER_NAMESPACE_LABEL.key}=${CONSUMER_NAMESPACE_LABEL.value}`;

function grantedNamespaceLabels(name: string, services: readonly string[]): ReadonlyArray<readonly [string, string]> {
  return [
    ["pod-security.kubernetes.io/enforce", "restricted"],
    [CONSUMER_NAMESPACE_LABEL.key, CONSUMER_NAMESPACE_LABEL.value],
    ["hostyour.cloud/consumer-name", name],
    ["platform/db-consumer", "true"],
    ...(services.includes("redis") ? ([["platform/redis-consumer", "true"]] as const) : []),
    ...(services.includes("postfix") ? ([["platform/postfix-consumer", "true"]] as const) : []),
  ];
}

/** Render the unit's ValidatingAdmissionPolicy + its Binding. `argoAppName` is the GENERATED
 *  Application's name (`<name>-<stage>`), the prefix every tracking id of this unit carries.
 *  `fqdn` is the unit's ATTESTED extra FQDN — the stage registration's own field, never the
 *  manifest's declaration — admitted IN ADDITION to `<name>.<unitApex>`, so a consumer that was
 *  granted its own domain serves both from the same Ingress while every ungranted name stays
 *  refused. `services` is the registration's ATTESTED claim list, likewise never the manifest's, and
 *  decides one label of the namespace clause. */
export function renderConsumerAdmissionPolicy(input: {
  name: string;
  namespace: string;
  unitApex: string;
  argoAppName: string;
  fqdn?: string;
  services?: readonly string[];
}): { policy: AdmissionPolicyManifest; binding: AdmissionPolicyBindingManifest } {
  const policyName = consumerAdmissionPolicyName(input.name);
  const host = `${input.name}.${input.unitApex}`;
  // The FQDNs the Ingress clause admits. The zod publicFqdn grammar (lowercase alphanumerics, `-`,
  // `.`) has already validated `fqdn` at both ends of the grant, so neither value can escape the
  // single-quoted CEL literals below.
  const fqdns = [host, ...(input.fqdn !== undefined ? [input.fqdn] : [])];
  return {
    policy: {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicy",
      metadata: { name: policyName, labels: { [CONSUMER_PROJECT_LABEL.key]: CONSUMER_PROJECT_LABEL.value } },
      spec: {
        failurePolicy: "Fail",
        matchConstraints: {
          resourceRules: [
            { apiGroups: ["networking.k8s.io"], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["ingresses"] },
            { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["services"] },
            { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["namespaces"] },
          ],
        },
        // The scope. Namespaced kinds are evaluated only inside the unit's own namespace; the
        // Namespace kind is ALWAYS evaluated, so the name clause below reaches a foreign name. A
        // Binding namespaceSelector cannot express this: for a Namespace object it is matched
        // against the object's own `kubernetes.io/metadata.name` label, and a foreign name would
        // skip the policy instead of being refused by it.
        matchConditions: [
          { name: "unit-scope", expression: `request.resource.resource == 'namespaces' || request.namespace == '${input.namespace}'` },
        ],
        validations: [
          {
            // Every rule's FQDN must be one of the granted set. A rule without one serves every FQDN
            // that reaches the manager, so an absent field is a violation, not an exemption.
            expression: `request.resource.resource != 'ingresses' || (has(object.spec.rules) && object.spec.rules.all(r, has(r.host) && (${fqdns.map((f) => `r.host == '${f}'`).join(" || ")})))`,
            message: `a consumer Ingress may only serve ${fqdns.length === 1 ? "the FQDN" : "the FQDNs"} ${fqdns.join(" and ")}`,
          },
          {
            // Every tls host must be granted too: a tls entry drives a certificate order against the
            // shared cluster-issuer, so a host here is a claim even when no rule serves it. An entry
            // without hosts is a violation, not an exemption (it would ride the default certificate).
            expression: `request.resource.resource != 'ingresses' || !has(object.spec.tls) || object.spec.tls.all(t, has(t.hosts) && t.hosts.all(h, ${fqdns.map((f) => `h == '${f}'`).join(" || ")}))`,
            message: `a consumer Ingress tls entry may only carry ${fqdns.length === 1 ? "the FQDN" : "the FQDNs"} ${fqdns.join(" and ")} — a certificate is only ordered for granted names`,
          },
          {
            // The platform address stands in a tls entry of its own. cert-manager's ingress-shim
            // builds ONE Certificate per tls entry and an ACME order is atomic: sharing the entry
            // with a granted customer domain would tie the platform certificate's renewal to a DNS
            // record the platform does not control, and its expiry would take the unit's own
            // address down weeks after an onboard nobody remembers.
            expression: `request.resource.resource != 'ingresses' || !has(object.spec.tls) || object.spec.tls.all(t, !(has(t.hosts) && ('${host}' in t.hosts) && t.hosts.size() > 1))`,
            message: `the platform FQDN ${host} must stand in a tls entry of its own — a shared entry is one atomic certificate order, and a name pointed elsewhere would block its renewal`,
          },
          {
            // The API server defaults an omitted type to ClusterIP before this policy runs; the
            // has() guard covers a submission the defaulter has not touched.
            expression: `request.resource.resource != 'services' || !has(object.spec.type) || object.spec.type == 'ClusterIP'`,
            message: "a consumer Service must be of type ClusterIP",
          },
          ...namespaceValidations({
            subject: "a consumer",
            namespace: input.namespace,
            argoAppName: input.argoAppName,
            granted: grantedNamespaceLabels(input.name, input.services ?? []),
          }),
        ],
      },
    },
    binding: {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicyBinding",
      metadata: { name: policyName, labels: { [CONSUMER_PROJECT_LABEL.key]: CONSUMER_PROJECT_LABEL.value } },
      spec: {
        policyName,
        validationActions: ["Deny"],
        // No matchResources: the binding arms the policy for everything matchConstraints names, and
        // the scoping lives in the policy's matchConditions. A namespaceSelector here would be
        // matched against a Namespace object's own labels and skip every foreign namespace name —
        // the exact admission the name clause exists to refuse.
      },
    },
  };
}

/** The label pairs the platform itself puts on a tenant MEMBER namespace — the ONLY values admitted
 *  under the reserved prefixes. They are the managedNamespaceMetadata of the four tenant
 *  ApplicationSets (hostyour-cloud/argocd/<stage>/apps/tenants-{auth,jobs,report,apps}-appset.yaml),
 *  identical across the three stages: every member carries platform/tenant=<guid>,
 *  platform/tenant-managed and platform/db-consumer; ONLY the auth member additionally carries
 *  platform/redis-consumer — example-auth keeps the tenant's sessions on the no-auth Redis, and no
 *  other member may write itself into that NetworkPolicy's selector. NO pod-security pair is in the
 *  set because the tenant appsets stamp none, so ANY pod-security.kubernetes.io/* label a member's
 *  chart writes — `enforce: privileged` included — is refused. */
// The extra labels are DECLARED, not deduced from the name. This read `member === "auth"` and handed
// out platform/redis-consumer — the platform knowing that one product's IdP keeps its sessions on
// Redis. The tenant product declares them per member (TenantMemberSchema.namespaceLabels) and the
// grant follows the declaration.
function grantedTenantNamespaceLabels(
  guid: string,
  extra: Readonly<Record<string, string>> = {},
): ReadonlyArray<readonly [string, string]> {
  return [
    ["platform/tenant", guid],
    [TENANT_MANAGED_LABEL, "true"],
    ["platform/db-consumer", "true"],
    ...Object.entries(extra).map(([k, v]) => [k, v] as const),
  ];
}

/** Render ONE tenant member's ValidatingAdmissionPolicy + its Binding — the Namespace clauses of the
 *  consumer boundary with the tenant's own granted set, nothing more. A member's chart is the
 *  platform's own (catalog), so its Ingress hosts and Service types are not fenced here; what
 *  IS fenced is the one cluster-scoped kind the member's AppProject whitelists: its Namespace
 *  objects may name only the member's own namespace and may carry nothing under the platform's
 *  label namespaces beyond the pairs the tenant ApplicationSets stamp. Every name comes from
 *  tenant-fanout (never hand-composed), so the policy, the AppProject and the generated Application
 *  agree on the member's identity by construction. */
export function renderTenantMemberAdmissionPolicy(input: { guid: string; member: string; stage: Stage; namespaceLabels?: Readonly<Record<string, string>> }): { policy: AdmissionPolicyManifest; binding: AdmissionPolicyBindingManifest } {
  const policyName = tenantMemberAdmissionPolicyName(input.guid, input.member);
  const namespace = memberNamespace(input.guid, input.member);
  // The generated member Application's name — the prefix of every tracking id this member owns,
  // exactly as the tenant ApplicationSets template it.
  const argoAppName = memberApplication(input.guid, input.member, input.stage);
  return {
    policy: {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicy",
      metadata: { name: policyName, labels: { [TENANT_PROJECT_LABEL.key]: TENANT_PROJECT_LABEL.value } },
      spec: {
        failurePolicy: "Fail",
        matchConstraints: {
          resourceRules: [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["namespaces"] }],
        },
        // Empty on purpose. The consumer policy's unit-scope condition exists to confine its
        // NAMESPACED kinds (Ingress, Service) to the unit's own namespace; this policy watches only
        // the cluster-scoped Namespace kind, and every Namespace admission must be evaluated so the
        // own-name clause can reach a foreign name — there is no request left to skip. The reach
        // limiter is the tracking id inside the clauses, exactly as in the consumer policy. A
        // Binding namespaceSelector could not scope this either way: for a Namespace object it is
        // matched against the object's own labels, and a foreign name would skip the policy instead
        // of being refused by it.
        matchConditions: [],
        validations: namespaceValidations({
          subject: "a tenant member",
          namespace,
          argoAppName,
          granted: grantedTenantNamespaceLabels(input.guid, input.namespaceLabels ?? {}),
        }),
      },
    },
    binding: {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicyBinding",
      metadata: { name: policyName, labels: { [TENANT_PROJECT_LABEL.key]: TENANT_PROJECT_LABEL.value } },
      spec: {
        policyName,
        validationActions: ["Deny"],
        // No matchResources, for the reason stated on the matchConditions above and on the consumer
        // binding: the scoping that exists lives inside the policy, never in a namespaceSelector.
      },
    },
  };
}
