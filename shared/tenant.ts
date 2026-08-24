// shared/tenant.ts — the tenant (multi-app package) REGISTRATION contract, the structural mirror of
// consumer.ts:ConsumerRegistrationSchema. A tenant is a "meta consumer": its repo is always
// catalog, its registration fans out to one ArgoCD Application per MEMBER (the trio
// auth/jobs/report plus one per app), and its "chart" is a package. The fan-out this registration
// expands to is server/domains/units/tenant-fanout.ts.
//
// Import boundary: shared/ is isomorphic (the web bundle imports it), so this file imports ONLY
import { UnitQuotaSchema } from "./unit-size.ts";
// other shared/ modules + zod — never node:crypto (guid MINTING lives server-side in
// server/kernel/ids.ts) and never server/. The graph stays acyclic: enums <- consumer <- gates <-
// tenant, and tenant is a pure leaf (it imports consumer/gates/enums; nothing imports it back).
import { z } from "zod";
import { GateResultSchema } from "./gates.ts";
import { ConsumerManifestSchema } from "./consumer.ts";

/** GUID_ALPHABET — Crockford base32 (minus i/l/o/u): 32 symbols = 10 digits + 22 lower-case
 *  letters. mintTenantGuid() (server/kernel/ids.ts) draws 12 chars from this set; the `guid`
 *  regex below is the schema-side mirror. */
export const GUID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A tenant guid: exactly 12 chars of GUID_ALPHABET. Verified against the two live guids
 *  zsjs023ctne0 and e2e8ymj86dk8. The guid is the SOLE tenant identity: it is the BRACKET every
 *  member is named from (namespace == AppProject == <guid>-<member>), and the registration path is
 *  registrations/<guid>/<stage>.yaml. */
export const guid = z.string().regex(/^[0-9a-hjkmnp-tv-z]{12}$/);

/** A tenant app name: a lower-case DNS-1123-style label, 2..30 chars. Each app is a MEMBER of the
 *  tenant: namespace <guid>-<name>, AppProject <guid>-<name>, Application <guid>-<name>-<stage>. */
export const appName = z.string().regex(/^[a-z][a-z0-9-]{0,28}[a-z0-9]$/);

/** A member's name — a standing member's or an app's. Both name the SAME thing: the suffix of a
 *  namespace, an AppProject and an Application, all `<guid>-<name>`. One grammar, because a
 *  collision between the two kinds is exactly what has to be impossible. */
export const memberName = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/);

/** ONE chart render of a member, RESOLVED — the chart, the extra value files and the values, with every
 *  `{app}` already substituted. Nothing here is composed by the platform: chart, file names and value
 *  keys all come out of the product's manifest. */
export const TenantSourceRecordSchema = z.object({
  chart: z.string().regex(/^[^/].*$/),
  valueFiles: z.array(z.string()).default([]),
  values: z.record(z.string(), z.unknown()).default({}),
});
export type TenantSourceRecord = z.infer<typeof TenantSourceRecordSchema>;

/** ONE member of a tenant, RESOLVED — everything the ApplicationSet needs to render it, because the
 *  generator reads `registrations/<guid>/<stage>.yaml` and nothing else. The product's manifest
 *  declares how a member is built (TenantSpecSchema.members for the standing ones, TenantSpecSchema
 *  .perApp for the selected apps); the Manager resolves that against THIS tenant and writes the
 *  result here.
 *
 *  Standing members and app members are the same thing in this list, which is what let twelve
 *  ApplicationSets — four member families x three stages, each naming a chart of one product —
 *  become one per stage. A member with two sources is an app (an engine and a front); a member with
 *  one is a standing service. Neither the appset nor anything else in the platform needs to tell them
 *  apart, so neither does.
 *
 *  `sources` is why this is a record and not a name. The appsets used to carry the charts and template
 *  the per-member values themselves, and one of those templates carried `report:Designer,report:Viewer`
 *  as a literal — a member name of one product, inside a values string, where no schema could see it.
 *  What the appset still adds at render time is the tenant's own facts (guid, subdomain, stage, member,
 *  appName, apps, seedUsers, suspended, quiesced): every source gets those and each chart uses the ones
 *  it needs, so no member's business reaches the platform.
 *
 *  `namespaceLabels`, and `valueFiles`/`values` on each source, DEFAULT rather than being optional, so
 *  the serialized registration always carries all three. The ApplicationSet reads them bare under
 *  goTemplateOptions missingkey=error, where an absent field is a render failure for the whole tenant
 *  rather than an empty one. */
export const TenantMemberRecordSchema = z.object({
  name: memberName,
  /** Extra labels this member's namespace is granted beyond the ones every tenant namespace carries. */
  namespaceLabels: z.record(z.string(), z.string()).default({}),
  /** The charts this member deploys into its ONE namespace, in render order. */
  sources: z.array(TenantSourceRecordSchema).min(1),
});
export type TenantMemberRecord = z.infer<typeof TenantMemberRecordSchema>;

/** ONE tenant apps[] element — the single source of the per-app seed model + its legacy read-compat.
 *  Two INDEPENDENT seed tiers (engine app.ts): `seedReference` → SEED_APP_DATA_ON_BOOT (reference tier
 *  `seeds/`: roles, navigation, mandatory singles = an operator app's structural data, so buildproject/
 *  erp are USABLE) and `seedDemo` → SEED_DEMO_DATA_ON_BOOT (demo tier `seeds-demo/`: showcase records,
 *  e.g. the web home page). `seed` is the LEGACY demo alias — READ-ONLY: a pre-existing pointer
 *  carrying {name, seed} folds seed → seedDemo here and is NEVER re-emitted (the writer always
 *  serializes the canonical {name, seedReference, seedDemo}). Both default false, so a bare {name}
 *  from before the tiers parses unchanged and seeds nothing. Imported everywhere the apps element is validated. */
export const TenantAppSchema = z
  .object({
    name: appName,
    seedReference: z.boolean().default(false),
    seedDemo: z.boolean().default(false),
    seed: z.boolean().optional(),
  })
  .transform(({ name, seedReference, seedDemo, seed }) => ({
    name,
    seedReference,
    seedDemo: seedDemo || (seed ?? false),
  }));

/** subdomain — a public FQDN label (zero PII). A bounded DNS-subdomain form (not z.string().min(1))
 *  per the synthesis decision to anonymize + read as a public label, while still accepting the two
 *  live tenant subdomains (e.g. "simetrix.dev"). */
const subdomain = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/);

/** registrations/<guid>/<stage>.yaml — THE tenant registration, ONE flat file per tenant per stage.
 *  The guid is the DIRECTORY and the stage is the FILE NAME, so neither appears in the body: the path
 *  is the identity, and a body field mirroring it would be a second writer of the same datum.
 *  Structural mirror of ConsumerRegistrationSchema, but repoURL/repoCredentialId are DELIBERATELY
 *  ABSENT: a tenant's repo is always catalog and the credential is the manager's first-party
 *  write credential, both constants of the one-time catalog registration.
 *
 *  `seedUsers`, `resetNonce`, `suspended` and `quiesced` are MANDATORY with a default and are written
 *  explicitly on every commit, so a chart may read them BARE under `missingkey=error` without a `dig`.
 *  Kept fully JSON-round-trip-clean so the registry serializer's serialize -> validate -> re-parse law
 *  holds. */
export const TenantRegistrationSchema = z
  .object({
    // The target SLAVE the tenant fans out on — the ArgoCD-REGISTERED cluster name (plane
    // clusterShortName of the cluster's domain, e.g. "s1"). A DNS-1123 label: it is the AppProject
    // destination `name:` pin AND the appset's destination selector, never a free-form string.
    cluster: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
    subdomain,
    // Per-app seed tiers: each element carries seedReference (reference tier → SEED_APP_DATA_ON_BOOT)
    // and seedDemo (demo tier → SEED_DEMO_DATA_ON_BOOT), both default OFF, threaded to the engine via
    // the tenant apps ApplicationSet. A registration carrying only `name` or `{name, seed}` folds in
    // TenantAppSchema (seed → seedDemo).
    apps: z.array(TenantAppSchema).default([]),
    // EVERY member this tenant has, resolved: the standing members the tenant product declared at
    // create time, and one per selected app. This is what the ApplicationSet fans out over — one
    // Application per element — and it is the reason there is ONE appset per stage where there used
    // to be four, each naming a chart of one product.
    //
    // Recorded, not re-derived. Every teardown, purge and relocation needs to know which namespaces
    // and AppProjects this tenant owns, and re-reading the product manifest would answer for the
    // manifest as it stands TODAY: a tenant created when the product declared three members and torn
    // down after it declared four would leave one namespace standing, with its Vault path and its
    // databases. The set a tenant HAS is a fact about that tenant.
    members: z.array(TenantMemberRecordSchema).min(1),
    // WHICH of those members is this tenant's identity provider. Recorded for the same reason the set
    // is: the activation and every relocation reach the IdP's namespace and its public host, and
    // re-reading the product manifest would answer for the manifest as it stands today. One of
    // `members`, enforced below.
    identityProvider: memberName,
    // The ceiling EVERY member namespace of this tenant is bounded by, resolved by the Manager from
    // its size table when it writes the registration and passed to hostyour-cloud/apps/unit-quota by the
    // tenant ApplicationSet. Per MEMBER and not per tenant, because a tenant owns one namespace per
    // member: a tenant of four members with a `small` size gets four small ceilings, and one member
    // filling its own cannot take another member's room.
    //
    // The FIGURES and not a size name, for the reason shared/unit-size.ts states: the table lives in
    // the Manager's database, which no cluster can read, so the registration carries what the unit
    // gets rather than a word to look up.
    quota: UnitQuotaSchema,
    seedUsers: z.boolean().default(false), // flips the IdP's user boot-seed
    resetNonce: z.string().min(1).default("1"), // bump + commit triggers a tenant reset (Tenant CR annotation)
    suspended: z.boolean().default(false), // tenant-wide pause: replicas 0, no Ingress
    quiesced: z.boolean().default(false), // the deeper pause a removal-in-flight holds a tenant in
  })
  .superRefine((e, ctx) => {
    // Two members may not share a name: a member's name IS its namespace, its AppProject and its
    // Application suffix, all `<guid>-<name>`, so the second would land on the first. This is also
    // where an app named after a standing member is caught, because an app IS a member here — the
    // check no longer needs a reserved-name list. `RESERVED_APP_NAMES` stood in this file as the
    // literal set {auth, jobs, report}: three component names of one product, reserved in the
    // platform for every tenant of every product it will ever host.
    const members = new Set(e.members.map((m) => m.name));
    if (members.size !== e.members.length) {
      const dup = e.members.map((m) => m.name).find((n, i, all) => all.indexOf(n) !== i);
      ctx.addIssue({ code: "custom", path: ["members"], message: `two members are both named "${dup}" — a member's name IS its namespace, AppProject and Application suffix, so the second would land on the first` });
    }
    if (!members.has(e.identityProvider)) {
      ctx.addIssue({
        code: "custom",
        path: ["identityProvider"],
        message: `identityProvider "${e.identityProvider}" is not one of this tenant's members (${[...members].join(", ")}) — the activation would reach a namespace the tenant does not own`,
      });
    }
    // Every selected app renders as a member, and the app members are the TAIL of the list, in apps
    // order — the exact shape the resolver writes (the product's standing members first, then one per
    // app). apps[] is the INPUT: its names and its per-app seed tiers. members[] is what the appset
    // fans out over.
    //
    // Holding the tail rather than mere membership is what still catches an app named after a standing
    // member. Under the old form that was a reserved-name list; here the resolver emits TWO members of
    // that name, standing and app, and the duplicate check above refuses it. A hand-written
    // registration carrying only the standing one would otherwise slip through and hand the app the
    // IdP's namespace.
    const appNames = e.apps.map((a) => a.name);
    const tail = appNames.length > 0 ? e.members.slice(-appNames.length).map((m) => m.name) : [];
    appNames.forEach((name, i) => {
      if (tail[i] !== name) {
        ctx.addIssue({
          code: "custom",
          path: ["apps", i, "name"],
          message: `app "${name}" has no member of its own — every app renders as a member, appended after the standing ones in apps order, and this list ends with (${tail.join(", ") || "nothing"})`,
        });
      }
    });
    // Uniqueness (C3-style): the guid × apps[] matrix keys each member by app name.
    const names = e.apps.map((a) => a.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", path: ["apps"], message: "apps[].name must be unique within a tenant" });
    }
  });
export type TenantRegistration = z.infer<typeof TenantRegistrationSchema>;

/** The ArgoCD UI deep-link for a tenant's fan-out — the tenant analogue of consumer.ts:consumerArgocdUrl.
 *  A tenant is one Application per member, not one, so this links to the
 *  argocd applications LIST filtered to the tenant's own label (platform/tenant=<guid>, the same
 *  selector the set-watches use), where the whole fan-out shows together. Host derivation matches
 *  consumerArgocdUrl: argo.<masterFqdn> for the master self-cluster (argoNamespace "argocd"),
 *  argo-<slave>.<masterFqdn> otherwise. Returns null when the master FQDN is unknown — the caller then
 *  renders no link rather than a broken one. */
export function tenantArgocdUrl(masterFqdn: string | null, argoNamespace: string, guid: string): string | null {
  if (!masterFqdn) return null;
  const host = argoNamespace === "argocd" ? `argo.${masterFqdn}` : `argo-${argoNamespace}.${masterFqdn}`;
  return `https://${host}/applications?labels=${encodeURIComponent(`platform/tenant=${guid}`)}`;
}

/** TenantValidationReportSchema — the tenant-shaped report envelope. It reuses the exact
 *  GateResultSchema[]/verdict shape (so the T1..T4 gates render through the identical gate-card web
 *  card with zero UI fork), but its top-level metadata is fan-out-shaped: chartsRef (THE pin),
 *  probeGuid (the throwaway guid the fan-out was rendered at), appsValidated[] and resolvedMembers[]
 *  replace the consumer report's single chartPath. manifest carries the parsed
 *  catalog ConsumerManifest for audit (null when T1 could not parse it). */
export const TenantValidationReportSchema = z.object({
  resolvedSha: z.string().regex(/^[0-9a-f]{40}$/),
  chartsRef: z.string().regex(/^[0-9a-f]{40}$/), // == resolvedSha (the fan-out pin)
  probeGuid: guid, // the throwaway guid the members were rendered at
  appsValidated: z.array(appName), // apps[] names whose per-app members were rendered
  resolvedMembers: z.array(z.string()), // the resolved fan-out member identifiers
  startedAt: z.number(),
  finishedAt: z.number(),
  manifest: ConsumerManifestSchema.nullable(), // null <=> T1 (manifest parse) failed
  gates: z.array(GateResultSchema),
  verdict: z.enum(["pass", "fail"]),
  reportHash: z.string(), // sha256 over the canonical JSON minus this field
});
export type TenantValidationReport = z.infer<typeof TenantValidationReportSchema>;
