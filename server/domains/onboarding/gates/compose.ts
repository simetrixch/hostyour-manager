// Gate composition. The gate-runner authors the sandbox gates inside its
// fenced sandbox and returns them in a schema-valid GateReport whose reportHash is recomputed and
// verified at the gate-runner adapter boundary ON RECEIPT (gate-runner-tekton.ts poll — the report
// crosses the sandbox->Controller hop as a ConfigMap, and a body that does not hash to its own
// reportHash is refused there). This module then appends the CONTROLLER-SIDE gates — the
// ones that need facts only the Controller holds (did the clone succeed? what do the OTHER units'
// registrations attest?) — and recomputes the verdict over all the gates.
//
// Every gate here is HARD and UNCONDITIONAL: it is emitted for every onboarding and either passes or
// fails it. There is no severity switch and no path that skips a gate.
//
// reportHash is left as the runner authored it: an UNKEYED sha256 over the runner's portion,
// verified at receipt — it refuses corruption and a body rewritten without recomputing the hash,
// not a forger holding the report-writer credential. The controller-side gates are authored locally
// and never cross a trust boundary, so the composed report's integrity beyond the runner's portion
// is the Controller's own DB (the frozen runs.plan_json). Keeping this function pure — no crypto,
// no IO — is what lets it live in the domain and satisfy the boundary law.
import { hardGatesPass, type GateReport, type GateResult } from "../../../../shared/gates.ts";
import type { Stage } from "../../../../shared/enums.ts";
import type { ChartPinMapping } from "../builds.ts";
import { BUILD_NAMESPACE_SUFFIX } from "../build-rbac.ts";
import { RESERVED_PROJECT_NAMES } from "../../../adapters/kube/port.ts";

/** One build name another unit has already attested in its `registrations/<unit>/build.yaml`. */
export interface ForeignBuild {
  unit: string;
  build: string;
}

/** One extra FQDN another unit has already attested in a `registrations/<unit>/<stage>.yaml`. */
export interface ForeignFqdn {
  unit: string;
  stage: Stage;
  fqdn: string;
}

// The manifest's build names and the chart's values file are UNTRUSTED input, and GateResultSchema
// caps expected/found/reason at 2000 chars — a report over the cap fails its own schema and would
// wedge the run instead of rejecting it. Every list built from repo content goes through this.
const TEXT_CAP = 600;
const cap = (text: string): string => (text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text);

/** The namespaces the PLATFORM itself stands in on a cluster, so no unit may be named after one —
 *  the unit's name IS its namespace (the identity law), and the consumers ApplicationSet pins the
 *  generated Application's destination to that namespace with CreateNamespace=true, so a unit named
 *  `mongodb` would have its chart synced INTO the platform's mongodb namespace, its pods beside the
 *  database's root-credential Secrets (a same-namespace mount needs no RBAC).
 *
 *  Enumerated from the code that creates them, in hostyour-cloud:
 *    - argocd/<stage>/apps/applicationset.yaml — the stage appset's destination namespaces
 *      (identical across dev/test/prod);
 *    - base/lib/deploy-argocd.sh, deploy-vault.sh, deploy-idp.sh — the namespaces the installer
 *      creates before ArgoCD exists (argocd, vault, idp, kubernetes-dashboard);
 *    - base/configs/config.example ADDONS — the MicroK8s addons that bring their own namespace
 *      (cert-manager, ingress); the remaining addons live in kube-system, which the `kube-` prefix
 *      clause of the name gate covers together with Kubernetes' other reserved namespaces. */
export const PLATFORM_NAMESPACES: readonly string[] = [
  "default",
  "argocd", "controller", "dbgate", "example-system", "external-secrets", "gate-runner",
  "image-builder", "kube-system", "mongodb", "observability", "postfix",
  "redis", "registry", "service-provisioner", "tailnet-coordinator",
  // The tekton catalog element renders three namespaces of its own, not one: the pipeline
  // controller in `tekton`, the remote-resolver deployment in `tekton-resolvers` and the read-only
  // UI in `tekton-dashboard` (hostyour-cloud/apps/tekton/templates/release-pipelines.yaml and
  // release-dashboard.yaml). All three carry the build plane's own ServiceAccounts.
  "tekton", "tekton-resolvers", "tekton-dashboard",
  "vault", "idp", "kubernetes-dashboard",
  "cert-manager", "ingress",
];

/** G23 unit name (HARD). What a unit may be NAMED, refused here — at admission, before anything is
 *  written — because the platform composes further identities from the name: the namespace and the
 *  AppProject are the name itself, the build namespace is `<name>-build`, the public host is
 *  `<name>.<unitApex>`. A name inside a space the platform already owns therefore hands the unit an
 *  identity with another owner, and every writer downstream would obey the pin. Five reserved
 *  spaces, each with its owner:
 *    - PLATFORM_NAMESPACES (above) — the unit's chart would sync into a platform namespace;
 *    - the `kube-` prefix, which Kubernetes reserves for its own namespaces;
 *    - the derived build-namespace space: a name ending in the build suffix IS `<unit>-build` for
 *      some unit — pinning this unit's AppProject into that build namespace, where the shared
 *      registry push credential and that unit's repo PAT are materialized as Secrets. Refused for
 *      units that do not exist yet as well: onboarding `acme` later would derive `acme-build`, the
 *      namespace such a consumer already occupies.
 *    - RESERVED_PROJECT_NAMES — the per-unit AppProject is named by the unit, and these names are
 *      the platform's shared ArgoCD projects; the writer refuses them mid-run (fail-closed), this
 *      clause moves the answer to admission;
 *    - the subdomains the TENANTS stand on. A tenant's IdP scopes every session cookie to
 *      `<subdomain>.<unitApex>` — the same string a consumer of that name would serve — so a
 *      consumer here is handed the tenant's users' sessions by their own browsers. The composition
 *      and the cookie chain are spelled out in unit-dns.ts; create-tenant holds the mirror of this
 *      clause (ensure-subdomain-free in tenant-replace.ts).
 *
 *  `tenantSubdomains` is every subdomain a tenant stands at, over every stage: the host carries no
 *  stage, and two clusters may share one apex, so a stage-scoped set would miss the collision the
 *  browser does not miss. */
export function gateG23(input: { unitName: string; tenantSubdomains: readonly string[] }): GateResult {
  const name = input.unitName;
  const collisions: string[] = [];
  if (PLATFORM_NAMESPACES.includes(name)) {
    collisions.push(`"${name}" is a platform namespace — the generated Application would sync the unit's chart into it, beside the platform's own Secrets`);
  }
  if (name.startsWith("kube-")) {
    collisions.push(`"${name}" carries the kube- prefix Kubernetes reserves for its own namespaces (kube-system, kube-public, kube-node-lease)`);
  }
  if (name.endsWith(BUILD_NAMESPACE_SUFFIX)) {
    const owner = name.slice(0, -BUILD_NAMESPACE_SUFFIX.length);
    collisions.push(
      `"${name}" is the derived build namespace of a unit named "${owner}" — every unit's release pipeline, the shared registry push credential and its repo PAT live in <unit>${BUILD_NAMESPACE_SUFFIX}, whether that unit is onboarded yet or not`,
    );
  }
  if (RESERVED_PROJECT_NAMES.includes(name)) {
    collisions.push(`"${name}" is a shared ArgoCD project name — the per-unit AppProject is named by the unit and may not shadow a platform project`);
  }
  if (input.tenantSubdomains.includes(name)) {
    collisions.push(
      `"${name}" is the subdomain a tenant stands on — its example-auth scopes every session cookie to <subdomain>.<unitApex>, the exact host this unit would serve, so every browser holding that tenant's session would send it here`,
    );
  }
  const ok = collisions.length === 0;
  return {
    id: "G23",
    title: "unit name",
    severity: "hard",
    status: ok ? "pass" : "fail",
    expected: `the name "${name}" lies in no space the platform composes identities from: not a platform namespace, not under Kubernetes' kube- prefix, not in the derived build-namespace space <unit>${BUILD_NAMESPACE_SUFFIX}, not a shared ArgoCD project name, not a subdomain a tenant stands on`,
    found: ok
      ? `"${name}" collides with no reserved name space — the namespace, the AppProject, the build namespace it derives and the public host are free to be this unit's (checked against ${input.tenantSubdomains.length} tenant subdomain(s))`
      : cap(collisions.join("; ")),
    reason: ok
      ? null
      : "a unit is deployed into the namespace named by its name, fenced by the AppProject named by its name and served at the host composed from its name, so a reserved name hands it an identity another owner holds; a unit is named by its repo, so rename the repo and onboard again",
    detail: ok ? "unit name is free" : "unit name is reserved",
    evidence: collisions.slice(0, 5).map((c) => ({ source: "controller" as const, name, value: c.slice(0, 256) })),
  };
}

/** G16 build-name uniqueness (HARD). An image name is FLAT — the build name IS the registry
 *  repository — so two units claiming the same name would push to the same repo, and the release
 *  bump's search over `builds[].image` would move the other unit's pins. Uniqueness is therefore
 *  CHECKED against what the other units have attested, never constructed from a prefix: the old
 *  ownership law (name == unit || `<unit>-*`) is not a rule the platform's own names obey
 *  (`example-engine` belongs to `example-platform`, `controller` to `hostyour-manager`).
 *
 *  `foreignBuilds` is the union of `builds[]` over every OTHER unit's build.yaml on the registration
 *  branch. That union is complete: only a unit's own release pipeline pushes, and that pipeline
 *  exists only where a registration exists. */
export function gateG16(input: {
  unitName: string;
  buildNames: readonly string[];
  foreignBuilds: readonly ForeignBuild[];
}): GateResult {
  const owners = new Map(input.foreignBuilds.map((f) => [f.build, f.unit]));
  const collisions = input.buildNames
    .map((name) => ({ name, unit: owners.get(name) }))
    .filter((c): c is { name: string; unit: string } => c.unit !== undefined);
  const ok = collisions.length === 0;
  return {
    id: "G16",
    title: "build-name uniqueness",
    severity: "hard",
    status: ok ? "pass" : "fail",
    expected: `every build name "${input.unitName}" declares is claimed by no other unit — a build name is the flat image name, so two units on one name push to the same registry repository`,
    found: ok
      ? `${input.buildNames.length} declared build name(s) checked against ${input.foreignBuilds.length} name(s) attested by other units — no collision`
      : cap(collisions.map((c) => `build "${c.name}" is already attested by unit "${c.unit}"`).join("; ")),
    reason: ok ? null : "a build name claimed by two units routes both to one registry repository; the onboarding is rejected",
    detail: ok ? "no foreign unit claims these names" : "build name already claimed",
    evidence: collisions.slice(0, 20).map((c) => ({ source: "controller" as const, name: c.name, value: c.unit.slice(0, 256) })),
  };
}

/** G18 build declaration (HARD), in two halves along its two subjects.
 *
 *  (a) MANIFEST half, for EVERY unit: `deploy/platform.yaml` declares at least one build. A repo with
 *      no build declared has nothing for the release cycle to produce, and the error would otherwise
 *      surface at the first release instead of here.
 *  (b) CHART half, only where the registration carries a chartPath: for every declared build the
 *      chart's `values-<stage>.yaml` states a `builds[]` entry whose `image` is that build name —
 *      precisely the key the release pipeline's bump task writes the tag into. The structure is
 *      checked, never a concrete tag: a unit that has never released carries a placeholder there.
 *      A build-only unit has no chart, so half (b) has no object and says so. */
export function gateG18(input: {
  declaredBuilds: readonly string[];
  chart: { path: string; stage: Stage; mapping: ChartPinMapping } | null;
}): GateResult {
  const chartExpected = input.chart
    ? `and ${input.chart.path}/values-${input.chart.stage}.yaml states a builds[] entry whose image is that name — the key the release bump writes the tag into`
    : "and, for a unit with a chart, that chart pins each of them";
  const expected = `deploy/platform.yaml declares at least one build, ${chartExpected}`;

  if (input.declaredBuilds.length === 0) {
    return {
      id: "G18",
      title: "build declaration",
      severity: "hard",
      status: "fail",
      expected,
      found: "no build declared in deploy/platform.yaml",
      reason: "a unit without a declared build produces no image, so its release cycle has nothing to run; the onboarding is rejected",
      detail: "empty builds[]",
    };
  }

  if (input.chart === null) {
    return {
      id: "G18",
      title: "build declaration",
      severity: "hard",
      status: "pass",
      expected,
      found: cap(`build-only — no chart to check; ${input.declaredBuilds.length} build(s) declared: ${input.declaredBuilds.join(", ")}`),
      reason: null,
      detail: "build-only unit",
    };
  }

  const { mapping, path, stage } = input.chart;
  const file = `${path}/values-${stage}.yaml`;
  const ok = mapping.error === null && mapping.missing.length === 0;
  const found = cap(
    mapping.error !== null
      ? `${file} is not readable as the builds[] pin grammar: ${mapping.error}`
      : ok
        ? `${input.declaredBuilds.length} declared build(s) pinned in ${file}: ${mapping.pinnedImages.join(", ")}`
        : `${file} states no builds[] entry for: ${mapping.missing.join(", ")}${mapping.pinnedImages.length ? ` (it pins ${mapping.pinnedImages.join(", ")})` : " (it pins nothing)"}`,
  );
  return {
    id: "G18",
    title: "build declaration",
    severity: "hard",
    status: ok ? "pass" : "fail",
    expected,
    found,
    reason: ok ? null : "the release bump writes a built image's tag into the builds[] entry that names it; without that entry the image is built and never reaches the cluster",
    detail: ok ? "every declared build is pinned" : "declared build not pinned",
    evidence: mapping.missing.slice(0, 20).map((name) => ({ source: "repo" as const, file, fieldPath: "builds[].image", value: name.slice(0, 256) })),
  };
}

/** G19 FQDN grant (HARD). A manifest may DECLARE one extra public FQDN (`fqdn`); the onboard run kind
 *  ATTESTS it into the stage registration, and only the attested value ever reaches the admission
 *  policy and the chart. What this gate refuses is a name the platform ALREADY SERVES:
 *
 *    - an attested fqdn of any other unit, or of THIS unit at another stage — two Ingress objects
 *      claiming one FQDN leave the ingress controller to route by arbitrary order, and even across
 *      clusters the one DNS record can point at only one of them, so a second attestation would
 *      raffle the first grant's traffic;
 *    - anything under (or equal to) the target cluster's own unitApex — those names are the
 *      platform's composition `<unit>.<unitApex>`, so a declared one could sit on another unit's
 *      address, or on the apex itself, without that unit ever attesting anything;
 *    - anything under (or equal to) the target cluster's own FQDN — the platform's infrastructure
 *      hostnames (vault.<fqdn>, argo.<fqdn>, build.<fqdn>, zot.<fqdn>) are composed there and have
 *      no registration, so the foreign-fqdn set cannot see them; where the unitApex is not a parent
 *      of the cluster FQDN, only this clause stands between a consumer and the shared ingress
 *      serving its paths under a platform service's address.
 *
 *  Whether the name RESOLVES here is deliberately not asked: the customer's DNS is the customer's
 *  business — a name pointed elsewhere is simply unreachable, and its own tls entry keeps the
 *  failure away from the unit's platform certificate. `unitApex`/`clusterDomain` are null exactly
 *  when no fqdn is declared (nothing to hold them against), so the structural clauses have an
 *  object only when the name does. */
export function gateG19(input: {
  unitName: string;
  fqdn: string | null;
  unitApex: string | null;
  clusterDomain: string | null;
  foreignFqdns: readonly ForeignFqdn[];
}): GateResult {
  const expected = `the fqdn "${input.unitName}" declares (if it declares one) is served by nothing on this platform yet — no stage registration attests it (another unit's or this unit's other stage), and it lies under neither the target cluster's unitApex nor the cluster's own FQDN`;
  if (input.fqdn === null) {
    return {
      id: "G19",
      title: "fqdn grant",
      severity: "hard",
      status: "pass",
      expected,
      found: "no fqdn declared — the unit serves only its platform address <name>.<unitApex>",
      reason: null,
      detail: "no fqdn declared",
    };
  }
  const collisions: string[] = [];
  if (input.unitApex !== null && (input.fqdn === input.unitApex || input.fqdn.endsWith(`.${input.unitApex}`))) {
    collisions.push(`"${input.fqdn}" lies under the cluster's unitApex "${input.unitApex}" — every name there is the platform's own composition <unit>.${input.unitApex}`);
  }
  if (input.clusterDomain !== null && (input.fqdn === input.clusterDomain || input.fqdn.endsWith(`.${input.clusterDomain}`))) {
    collisions.push(`"${input.fqdn}" lies under the cluster's own FQDN "${input.clusterDomain}" — the platform's infrastructure hostnames (vault., argo., build., zot.) are composed there`);
  }
  for (const f of input.foreignFqdns) {
    if (f.fqdn === input.fqdn) {
      collisions.push(
        f.unit === input.unitName
          ? `"${input.fqdn}" is already attested by this unit at ${f.stage} (registrations/${f.unit}/${f.stage}.yaml) — one FQDN cannot serve two stages, its one DNS record points at one of them`
          : `"${input.fqdn}" is already attested by unit "${f.unit}" at ${f.stage} (registrations/${f.unit}/${f.stage}.yaml)`,
      );
    }
  }
  const ok = collisions.length === 0;
  return {
    id: "G19",
    title: "fqdn grant",
    severity: "hard",
    status: ok ? "pass" : "fail",
    expected,
    found: ok
      ? `fqdn "${input.fqdn}" declared — checked against ${input.foreignFqdns.length} attested fqdn(s), the cluster's unitApex and the cluster's own FQDN, no collision`
      : cap(collisions.join("; ")),
    reason: ok ? null : "an FQDN the platform already serves cannot be attested twice — the ingress controller would resolve the conflict by arbitrary order; re-run the onboard after the name is free or the manifest names another",
    detail: ok ? `fqdn "${input.fqdn}" is free to attest` : "fqdn already served by this platform",
    evidence: ok ? [] : [{ source: "controller" as const, name: input.fqdn, value: collisions[0]!.slice(0, 256) }],
  };
}

/** G17 repo access — the Controller could clone the repo at the requested ref: public, or private
 *  with the operator-supplied read credential. The credential never enters the sandbox. */
export function gateG17(access: { ok: boolean; detail: string }): GateResult {
  return {
    id: "G17",
    title: "repo access",
    severity: "hard",
    status: access.ok ? "pass" : "fail",
    expected: "the Controller can clone the repository at the requested ref — public, or private with the operator-supplied read credential",
    found: access.detail,
    reason: access.ok ? null : "without repo access neither the sandbox nor ArgoCD can fetch the chart; the plan is rejected",
    detail: access.ok ? "clone succeeded" : "clone failed",
  };
}

/** Merge the runner's report with the controller-side gates and recompute the verdict over all the
 *  gates. The verdict is a pass only if every HARD gate (runner + controller) passed AND the
 *  runner's own verdict was a pass — the runner verdict folds in the other two triple-lock legs
 *  (the report schema-validated, and the sandbox self-probe attested). Pure: no IO, no mutation. */
export function composeReport(runner: GateReport, controllerGates: GateResult[]): GateReport {
  const gates: GateResult[] = [...runner.gates, ...controllerGates];
  const verdict: "pass" | "fail" = hardGatesPass(gates) && runner.verdict === "pass" ? "pass" : "fail";
  return { ...runner, gates, verdict };
}
