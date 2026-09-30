// shared/tenant.ts — the tenant (multi-app package) REGISTRATION contract, the structural mirror of
// consumer.ts:ConsumerRegistrationSchema. A tenant is a "meta consumer": its repo is always
// the deploy repository, its registration fans out to one ArgoCD Application per MEMBER (the trio
// auth/jobs/report plus one per app), and its "chart" is a package. The fan-out this registration
// expands to is server/domains/units/tenant-fanout.ts.
//
// Import boundary: shared/ is isomorphic (the web bundle imports it), so this file imports ONLY
import { UnitQuotaSchema } from "#unit/shared/unit-size.ts";
// other shared/ modules + zod — never node:crypto (guid MINTING lives server-side in
// server/kernel/ids.ts) and never server/. The graph stays acyclic: enums <- consumer <- gates <-
// tenant, and tenant is a pure leaf (it imports consumer/gates/enums; nothing imports it back).
import { z } from "zod";
import { GateResultSchema } from "./gates.ts";
import { ConsumerManifestSchema, publicFqdn } from "./consumer.ts";
import { HOST_LABEL_RE, RESERVED_HOST_LABELS } from "#unit/shared/unit-host.ts";
import { SEED_SELECTIONS } from "./app-selections.ts";
import { MEMBER_ROUTING, type Stage } from "./enums.ts";

/** The stages a tenant may have on a cluster of `clusterStage`: the cluster's own, and on a prod
 *  cluster a customer's test stage too (hostyour-manager#295). A cluster carries exactly the tenant
 *  stages its Vault holds a tenant role for: `tenant-eso-<its stage>`, and `tenant-eso-test` on a prod
 *  installation (hostyour-deploy deploy-platform-services.yaml and register-slave.yaml). The first
 *  is the cluster's own stage, the one the create form offers first. */
export function tenantStagesOn(clusterStage: Stage): readonly Stage[] {
  return clusterStage === "prod" ? ["prod", "test"] : [clusterStage];
}

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

/** The databases one app declares in its catalog entry (apps.yaml), by name. The same list fills the
 *  `{databases}` token of the app's own member and stands in its `tenant.apps` entry, which every
 *  member of the tenant reads. */
export const appDatabases = z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).min(1);

/** A site of a website app folder: the id its content carries (a WebSite's `_id`, a WebPage's `site`). */
export const siteId = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

/** The app name of a website served at `domain`, an app name for every domain: the domain with `-`
 *  for every `.`, because a namespace and an Application name carry no dot (`example.ch` becomes
 *  `example-ch`). A domain that starts with a digit gets `web-` ahead (`1und1.de` becomes
 *  `web-1und1-de`). A name longer than an app name allows keeps its first 23 characters and ends in
 *  six hex digits of the domain's hash, so two long domains that begin alike get two names. */
export function websiteAppName(domain: string): string {
  const dashed = domain.split(".").join("-");
  const named = /^[0-9]/.test(dashed) ? `web-${dashed}` : dashed;
  if (named.length <= 30) return named;
  return `${named.slice(0, 23).replace(/-+$/, "")}-${fnv1a(domain).slice(0, 6)}`;
}

/** FNV-1a over the text, as eight hex digits. The browser and the server derive a website's name
 *  alike, and the browser has no synchronous hash of its own. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** What makes an apps[] entry a website: the folder it runs, the site it serves, the domain it is
 *  served at. */
export interface TenantWebsite {
  folder: string;
  site: string;
  domain: string;
}

/** The app folder an apps[] entry runs: its own `folder` (a website's), else the folder of its name. */
export function appFolder(app: { name: string; folder?: string }): string {
  return app.folder ?? app.name;
}

/** The app folders a list of apps runs, each once, in order: what their bundle carries. Two
 *  websites run one folder. */
export function appFolders(apps: readonly { name: string; folder?: string }[]): string[] {
  return [...new Set(apps.map(appFolder))];
}

/** A member's name — a standing member's or an app's. Both name the SAME thing: the suffix of a
 *  namespace, an AppProject and an Application, all `<guid>-<name>`. One grammar, because a
 *  collision between the two kinds is exactly what has to be impossible. */
export const memberName = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/);

/** A build's name, as a product's deploy/platform.yaml and tenant.buildRepos spell it. */
export const buildName = z.string().regex(/^[a-z0-9-]+$/);

/** An image tag the release pipeline pushes: the release tag and the commit, `<x.y.z>-<channel>-<ts14>-<sha7>`. */
export const approvedImageTag = z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.([0-9]{3}|0|[1-9][0-9]*)-(alpha|beta|stable)-[0-9]{14}-[0-9a-f]{7}$/, "an image tag <x.y.z>-<channel>-<ts14>-<sha7>");

/** Whether `next` is an older release than `held`, by the UTC second each was minted at: the ts14 of
 *  an approved image tag orders releases whatever their x.y.z says. A tag outside that grammar (the
 *  placeholder of a build no release has built) is no release, so it is older than nothing. */
export function isOlderRelease(next: string, held: string): boolean {
  if (!approvedImageTag.safeParse(next).success || !approvedImageTag.safeParse(held).success) return false;
  return next.split("-")[2]! < held.split("-")[2]!;
}

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
 *  `sources` is why this is a record and not a name. An appset that carried the charts and templated
 *  the per-member values itself would put a member name of one product — `report:Designer,report:Viewer`
 *  as a literal — inside a values string, where no schema could see it.
 *  What the appset still adds at render time is the tenant's own facts (guid, subdomain, stage, member,
 *  appName, apps, seedUsers, suspended, quiesced, appsImage, appsImageTag): every source gets those and
 *  each chart uses the ones it needs, so no member's business reaches the platform.
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
 *  `seeds/`: roles, navigation, mandatory singles = an operator app's structural data, so an
 *  operator app is USABLE) and `seedDemo` → SEED_DEMO_DATA_ON_BOOT (demo tier `seeds-demo/`: showcase
 *  records). `seed` is the LEGACY demo alias — READ-ONLY: a pre-existing pointer
 *  carrying {name, seed} folds seed → seedDemo here and is NEVER re-emitted (the writer always
 *  serializes the canonical {name, seedReference, seedDemo, selections}, with folder, site and domain
 *  on a website). Both default false, so a bare
 *  {name} from before the tiers parses unchanged and seeds nothing. `selections` carries every
 *  further selection the app's manifest declares; the two above are refused there, so one selection
 *  has one place. Imported everywhere the apps element is validated.
 *
 *  A WEBSITE is an app whose folder's catalog entry lists `sites`. It carries the folder it runs, the
 *  site it serves and the domain it is served at (`<domain>`, which `www.<domain>` redirects to), and it is named by that domain
 *  (websiteAppName), so one folder serves as many websites as there are domains. An entry
 *  without a folder runs the folder of its own name. */
export const TenantAppSchema = z
  .object({
    name: appName,
    folder: appName.optional(),
    site: siteId.optional(),
    domain: publicFqdn.optional(),
    seedReference: z.boolean().default(false),
    seedDemo: z.boolean().default(false),
    seed: z.boolean().optional(),
    // Copied off the catalog entry of the app's folder by the Manager, never typed by a person: every
    // member of the tenant reads it in `tenant.apps`, and the key is absent where the entry declares none.
    databases: appDatabases.optional(),
    selections: z
      .record(z.string(), z.boolean())
      .default({})
      .refine((s) => !SEED_SELECTIONS.some((k) => k in s), { message: `${SEED_SELECTIONS.join(" and ")} are fields of the app entry, never keys of selections` }),
  })
  .transform(({ name, folder, site, domain, seedReference, seedDemo, seed, databases, selections }) => ({
    name,
    ...(folder === undefined ? {} : { folder }),
    ...(site === undefined ? {} : { site }),
    ...(domain === undefined ? {} : { domain }),
    seedReference,
    seedDemo: seedDemo || (seed ?? false),
    selections,
    ...(databases === undefined ? {} : { databases }),
  }));

/** subdomain — ONE DNS label (zero PII). The tenant's zone is `<subdomain>.<stage apex>` and its
 *  wildcard `*.<subdomain>.<stage apex>` (unit-host.ts), so a dotted subdomain has no reading under
 *  it, and a stage word would make the zone another stage's apex: a prod tenant named `dev` gets
 *  `*.dev.<apex>`, the dev zone itself, and its identity provider scopes its cookies to that whole
 *  zone. Held here for the registration and, through the same export, at the wizard's request. */
export const subdomain = z
  .string()
  .regex(HOST_LABEL_RE, "a subdomain is one DNS label: lower-case letters, digits and hyphens, at most 63 characters, no dot")
  .refine((s) => !RESERVED_HOST_LABELS.includes(s), { message: "a stage word cannot be a subdomain — the stage words are the zones, so the tenant would take a whole stage's zone" });

/** THE TENANT'S OWN APPS BUNDLE — the three facts of its `<bundle>-<subdomain>` repository, a Build-only
 *  unit of this installation: the repository the bundle is rebuilt from, the flat build name its
 *  manifest declares (the registry repository the engines mount, `tenant.appsImage` in the engine
 *  chart) and the immutable image tag its last release built, read off that release's PipelineRun.
 *  The tag stands on the registration and not in a pins file because no chart's builds[] can name a
 *  per-tenant image: the release pipeline's bump seeds a chart's pins file from the chart's own
 *  builds[] and rewrites only the entries that stand there. Declared once, for the registration
 *  and for the tenant-create params, which carry the first two — the plan derives them from the
 *  subdomain and the GitHub App's owner, and the run reads the tag off the release it
 *  triggers. The REGISTRATION carries all three or none (`refineAppsBundle`): an image without its
 *  tag is nothing the engines can mount. The registration defaults `appsImage` and `appsImageTag`
 *  to the empty string when the tenant has none, so the tenants ApplicationSet may read both bare
 *  under missingkey=error; `appsRepo` reaches no chart and is simply absent then. */
export const appsBundleFields = {
  appsRepo: z.string().regex(/^https:\/\/[^ ]+\.git$/).optional(),
  appsImage: z.string().regex(/^([a-z0-9-]+)?$/).optional(),
  appsImageTag: z.string().optional(),
};
type AppsBundleFields = { appsRepo?: string | undefined; appsImage?: string | undefined; appsImageTag?: string | undefined };
const has = (v: string | undefined): boolean => v !== undefined && v !== "";
export function refineAppsBundle(e: AppsBundleFields, ctx: z.RefinementCtx): void {
  const bundle = [e.appsRepo, e.appsImage, e.appsImageTag].map(has);
  if (bundle.some(Boolean) && !bundle.every(Boolean)) {
    ctx.addIssue({ code: "custom", path: ["appsImage"], message: "a tenant's apps bundle is appsRepo, appsImage and appsImageTag together — the engines mount the image at that tag, and the run rebuilds it from that repository; one without the others can be neither mounted nor rebuilt" });
  }
}

/** registrations/<guid>/<stage>.yaml — THE tenant registration, ONE flat file per tenant per stage.
 *  The guid is the DIRECTORY and the stage is the FILE NAME, so neither appears in the body: the path
 *  is the identity, and a body field mirroring it would be a second writer of the same datum.
 *  Structural mirror of ConsumerRegistrationSchema, but repoURL/repoCredentialId are DELIBERATELY
 *  ABSENT: a tenant's repo is always the deploy repository and the credential is the manager's first-party
 *  write credential, both constants of the one-time deploy repository registration.
 *
 *  `seedUsers`, `resetNonce`, `suspended`, `quiesced`, `appsImage` and `appsImageTag` are MANDATORY
 *  with a default and are written explicitly on every commit, so a chart may read them BARE under
 *  `missingkey=error` without a `dig`. Kept fully JSON-round-trip-clean so the registry serializer's
 *  serialize -> validate -> re-parse law holds.
 *
 *  THE RULE FOR EVERY FIELD ADDED HERE: IT HAS A DEFAULT. A registration is written by the run that
 *  creates the tenant and rewritten only by a flip, so every file written before a field existed
 *  carries no key for it — and the tenants ApplicationSet reads the file bare, where a missing key is
 *  a render failure for the whole tenant. A standing installation is brought onto a new field by
 *  hand, once. An OPTIONAL field (`appsRepo`, where absent is a meaning) is left absent; a REQUIRED
 *  field with no default is a run kind's job — a run that knows the tenant. */
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
    // Application per element — and it is what lets ONE appset per stage stand where a set naming
    // one product's chart each would need four.
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
    // How these members are addressed below the zone (MEMBER_ROUTING): the product's declaration at
    // create time, moved on a standing file only by the run that also moves its DNS record. Defaulted
    // to `host`, the addressing every file written before the field existed was made under.
    routing: z.enum(MEMBER_ROUTING).default("host"),
    // The tenant's OWN DOMAIN, or "" where the tenant is reached at its zone: one FQDN the customer
    // brings, which replaces the zone as the tenant's one host, every member under a path of it. Moved
    // on a standing file only by tenant-set-own-domain, which also moves its DNS record. Defaulted to
    // "" for every file written before the field existed.
    ownDomain: z.union([z.literal(""), publicFqdn]).default(""),
    // The hosts that answer with a redirect to the own domain (the other spelling of it, most often),
    // named by the operator in tenant-set-own-domain; empty where there is none and always empty
    // without an own domain. Defaulted to [] for every file written before the field existed.
    ownDomainRedirects: z.array(publicFqdn).default([]),
    // The image tags approved for this tenant alone, per app and build: `<app> -> <build> -> <tag>`.
    // The app key is the name every member chart receives as tenant.appName (the app for a per-app
    // member, the member name for a standing one). A build with no approval follows the stage pin;
    // an approval is never an empty value, which the charts refuse. create-tenant and add-app write
    // the newest available version, and the tenant's Versions run (tenant-refresh-members) writes the
    // version chosen per part. Defaulted to {} for every file written before it existed.
    approvedTags: z.record(memberName, z.record(buildName, approvedImageTag)).default({}),
    // The domain the tenant's mail is sent as, or "" where it is sent as the platform's own domain.
    // Every member receives it as tenant.senderDomain; the product's charts send as
    // no-reply@<senderDomain> where it is set. Set only by tenant-set-sender-domain, after the
    // product's sender-domain check answered that mail from it is signed. Defaulted to "" for every
    // file written before the field existed.
    senderDomain: z.union([z.literal(""), publicFqdn]).default(""),
    // The ceiling EVERY member namespace of this tenant is bounded by, resolved by the Manager from
    // its size table when it writes the registration and passed to hostyour-cloud/apps/unit-quota by the
    // tenant ApplicationSet. Per MEMBER and not per tenant, because a tenant owns one namespace per
    // member: a tenant of four members with a `small` size gets four small ceilings, and one member
    // filling its own cannot take another member's room.
    //
    // The FIGURES and not a size name, for the reason plugins/unit/shared/unit-size.ts states: the table lives in
    // the Manager's database, which no cluster can read, so the registration carries what the unit
    // gets rather than a word to look up.
    quota: UnitQuotaSchema,
    seedUsers: z.boolean().default(false), // flips the IdP's user boot-seed
    // A demo tenant: present, and true, only for one. Every member receives it as tenant.demo, which the
    // product's charts turn into a one-click demo login and a nightly reset. Absent everywhere else,
    // and the tenant ApplicationSet reads it tolerantly, so a registration without it renders as before.
    demo: z.literal(true).optional(),
    resetNonce: z.string().min(1).default("1"), // bump + commit triggers a tenant reset (Tenant CR annotation)
    suspended: z.boolean().default(false), // tenant-wide pause: replicas 0, no Ingress
    quiesced: z.boolean().default(false), // the deeper pause a removal-in-flight holds a tenant in
    // The tenant's own apps bundle, all three or none (appsBundleFields above). The two the tenants
    // ApplicationSet reads bare default to the empty string HERE, so every registration a run writes
    // carries both; the params keep them optional.
    ...appsBundleFields,
    appsImage: appsBundleFields.appsImage.default(""),
    appsImageTag: appsBundleFields.appsImageTag.default(""),
  })
  .superRefine((e, ctx) => {
    refineAppsBundle(e, ctx);
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
    // member. A reserved-name list is the alternative; here the resolver emits TWO members of
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
 *  deploy repository's ConsumerManifest for audit (null when T1 could not parse it). */
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
