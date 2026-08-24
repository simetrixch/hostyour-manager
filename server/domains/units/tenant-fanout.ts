// tenant-fanout.ts — the PURE fan-out algebra (no IO) and the SINGLE source of truth for every name a
// tenant package carries. A tenant is a BRACKET over several SELF-CONTAINED members. Each member gets
// its OWN namespace, its OWN AppProject — both literally <guid>-<member> — and its OWN Application
// <guid>-<member>-<stage>.
//
// A member is one of two things, and the platform does not need to tell them apart:
//   - a STANDING member, declared in the tenant product's manifest (TenantSpecSchema.members), which
//     every tenant of that product has whether or not it selects an app. Nothing gates them — not a
//     flag, not the presence of a file — because a tenant's apps require those services to exist.
//   - an APP member, one per entry of the tenant's apps[], built from the manifest's `perApp` block.
//     It renders several charts (an engine and a front today) into its ONE namespace.
// Which members a product has, and what each is made of, is the PRODUCT's data. This module composes
// names out of it and never compares a member name against a literal.
//
// WHAT THE PER-MEMBER CUT BUYS. Nothing of a tenant lives in a namespace shared with a sibling, so
// tearing one member down leaves the others running, and the whole bracket — every namespace, every
// AppProject — moves together because every piece of it is named from the same guid. There is no
// namespace named by the bare guid and no member that carries shared pieces for the others.
//
// The Application NAMES here MUST match the tenant ApplicationSet in hostyour-cloud
// (argocd/<stage>/apps/tenants-appset.yaml), which fans out over the `members` of each registration
// registrations/<guid>/<stage>.yaml in catalog: one Application <guid>-<member>-<stage> into
// namespace <guid>-<member>, carrying that member's sources. EVERY name carries the -<stage> suffix.
//
// Three consumers pivot on this module and MUST agree:
//   1. the tenant validator (validate-tenant.ts) renders each resolveFanout member into its own
//      member namespace;
//   2. the set-watch (adapters/kube watchApplicationSet) waits on each tenantApplicationSet name to
//      reach Synced/Healthy — a name ArgoCD never creates hangs the watch forever;
//   3. create-tenant's TWO inventory writes (create-tenant.run.ts upsertTenantInventory) write one
//      tenant_apps row per app, keyed by <app>: record-provisional inserts them as "provisioning"
//      before anything is deployed, record-inventory settles them to "active".
//
// Boundary: pure leaf in the domain layer — type-only imports from shared/ (isomorphic), no adapters,
// no db, no node builtins.
import type { Stage } from "../../../shared/enums.ts";
import type { TenantSource, TenantSpec } from "../../../shared/consumer.ts";
import type { TenantMemberRecord, TenantSourceRecord } from "../../../shared/tenant.ts";
import { errValidation } from "../../kernel/errors.ts";

/** One RENDER unit of the fan-out: a chart plus the value files layered on it. `member` is the member
 *  the render belongs to and it is what names the namespace, the AppProject and the Application;
 *  `name` is a guid-less render id, the member name when the member has one source and
 *  `<member>-<n>` when it has several. A member with two sources produces two renders that share the
 *  ONE Application <guid>-<member>-<stage>, so the render set and the watch set differ.
 *
 *  There is no kind. It used to be `"standing" | "engine" | "front"` — before that, the three member
 *  names of one product — and nothing outside the tests read it: a render is a chart in a namespace
 *  whatever the product calls it. */
export interface FanoutMember {
  name: string;
  member: string;
  chart: string;
  valueFiles: string[];
}

/** A tenant app reference — structural (a parsed TenantRegistration["apps"][number] or a request app
 *  both satisfy it) so this pure module stays decoupled from the registration schema. */
export interface AppRef {
  name: string;
}

/** The tenant's own identity provider — the member the whole tenant authenticates against, so a
 *  caller that needs THAT member rather than the set can name it: the bootstrap-token Secret lives in
 *  its namespace, and its Application is the tenant's deployed-revision anchor.
 *
 *  Resolved from the spec, never a constant. `AUTH_MEMBER = "auth"` used to stand here, which is the
 *  cloud base knowing what one product calls its IdP. TenantSpecSchema enforces that exactly one
 *  member declares the flag, so this cannot come back empty for a spec that parsed. */
export function identityProviderMember(spec: TenantSpec): string {
  const m = spec.members.find((x) => x.identityProvider === true);
  if (!m) {
    throw errValidation("the tenant spec declares no identityProvider member — TenantSpecSchema requires exactly one, so this spec did not come through it");
  }
  return m.name;
}

/** ONE member's namespace: <guid>-<member>. THE name source — never hand-rolled anywhere else. */
export function memberNamespace(guid: string, member: string): string {
  return `${guid}-${member}`;
}

/** ONE member's AppProject. The identity law holds per member: the AppProject name IS the namespace,
 *  so the isolation project and the namespace it permits can never drift apart. */
export function memberAppProject(guid: string, member: string): string {
  return memberNamespace(guid, member);
}

/** ONE member's ArgoCD Application: <guid>-<member>-<stage>. */
/** The label every namespace and every Application of one tenant carries — the selector the fan-out
 *  watches filter by and the teardown reaps namespaces by. Declared here, with the rest of the tenant's
 *  naming, since the object it used to sit beside (the Tenant CR renderer) is gone. */
export const TENANT_LABEL_KEY = "platform/tenant";

export function memberApplication(guid: string, member: string, stage: Stage): string {
  return `${guid}-${member}-${stage}`;
}

/** Every namespace of a tenant — what a teardown reaps and a move carries.
 *
 *  Takes the tenant's member NAMES, which every caller holds already: the tenant's row, its
 *  registration, or the run's frozen params. They used to be the standing names plus the apps, and
 *  before that a constant — three names of one product living in the platform. */
export function tenantNamespaces(members: readonly string[], guid: string): string[] {
  return members.map((m) => memberNamespace(guid, m));
}

/** Substitute the ONE token the manifest defines, `{app}`, throughout a source. It reaches every
 *  valueFiles entry and every STRING inside values, at any depth — `values-{app}.yaml`,
 *  `example-engine-{app}`, `{ ingress: { engineService: "example-engine-{app}" } }`.
 *
 *  The token exists because a per-app chart's file names and its resource names are the product's own
 *  convention, and the platform must not compose them: `values-<app>.yaml` and `example-ui-<app>-tls`
 *  used to be built in the appsets, out of literals no schema could see. The product writes the whole
 *  string and the platform only fills in which app this is. */
function substituteApp(source: TenantSource, app: string | undefined): TenantSourceRecord {
  // A standing member has no app, so nothing is substituted for it — a `{app}` left in a standing
  // member's source is the product's own mistake and reaches the chart as written, where it fails
  // loudly, rather than silently becoming the empty string.
  const text = app === undefined ? (s: string) => s : (s: string): string => s.split("{app}").join(app);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  // Written whole, never spread-if-present: the registration always carries all three so the appset
  // can read them bare under missingkey=error.
  return {
    chart: text(source.chart),
    valueFiles: (source.valueFiles ?? []).map(text),
    values: walk(source.values ?? {}) as Record<string, unknown>,
  };
}

/** The sources ONE app renders: the engine, then the front — the front replaced wholesale when the
 *  product's override map names this app.
 *
 *  The map is keyed by app name, so the lookup IS the selection. This used to test `app === "web"`
 *  first and only then consult the map — a constant naming one app of one product, guarding a map
 *  that already answered for it. */
function appSources(spec: TenantSpec, app: string): TenantSourceRecord[] {
  const front = spec.perApp.front.override?.[app] ?? spec.perApp.front;
  return [substituteApp(spec.perApp.engine, app), substituteApp(front, app)];
}

/** EVERY member of a tenant, resolved into what the ApplicationSet renders: the standing members the
 *  product declares, verbatim, then one per selected app built from `perApp`. This is the ONE
 *  resolution — the registration records its output, the validator renders it, and the appset fans
 *  out over it. */
export function resolveMembers(spec: TenantSpec, apps: readonly AppRef[]): TenantMemberRecord[] {
  const standing: TenantMemberRecord[] = spec.members.map((m) => ({
    name: m.name,
    namespaceLabels: m.namespaceLabels ?? {},
    sources: [substituteApp(m, undefined)],
  }));
  // An app member carries no extra namespace labels: every app gets the same namespace, and a label
  // one app needs and another does not is a per-member fact the product would state on a member.
  return [...standing, ...apps.map((a) => ({ name: a.name, namespaceLabels: {}, sources: appSources(spec, a.name) }))];
}

/** The EXPECTED set of ArgoCD Application names for a tenant — the completeness gate the set-watch and
 *  record-inventory pivot on. One <guid>-<member>-<stage> per member, every name -<stage>-suffixed. */
export function tenantApplicationSet(members: readonly string[], guid: string, stage: Stage): string[] {
  return members.map((m) => memberApplication(guid, m, stage));
}

/** The resolved members FLATTENED to one entry per chart render — what the validator templates, one
 *  helm invocation each. A member with two sources produces two renders that share the ONE namespace
 *  `<guid>-<member>` and the ONE Application, so the render set and the watch set differ; `member`
 *  is what they agree on.
 *
 *  The value-file layering matches the appset exactly: the chart's own values.yaml, then
 *  values-<stage>.yaml, then whatever the source declares. */
export function resolveFanout(spec: TenantSpec, apps: readonly AppRef[], stage: Stage): FanoutMember[] {
  return resolveMembers(spec, apps).flatMap((m) =>
    m.sources.map((s, i) => ({
      name: m.sources.length > 1 ? `${m.name}-${i + 1}` : m.name,
      member: m.name,
      chart: s.chart,
      valueFiles: ["values.yaml", `values-${stage}.yaml`, ...(s.valueFiles ?? [])],
    })),
  );
}
