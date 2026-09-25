// Consumer contract types (v1.3) — the TypeScript mirror of the JSON Schemas that live in
// hostyour-cloud `docs/consumer-contract/`. Kept in shared/ so the gate-runner, the onboarding
// domain, and the web card all agree on one shape. The vendored JSON Schemas remain the
// authoritative contract; hostyour-cloud's tools/checks/consumer-contract.census.sh hashes them and
// fails when this mirror drifts.
import { z } from "zod";
import { UnitQuotaSchema, UnitSizeSchema, MongodbModeSchema, type UnitQuota, type UnitSize, type MongodbMode } from "#unit/shared/unit-size.ts";
import { MEMBER_ROUTING, STAGE, type Stage } from "./enums.ts";
import { HOST_LABEL_RE, RESERVED_HOST_LABELS } from "#unit/shared/unit-host.ts";

/** WHERE a consumer repository keeps its manifest. One spelling, because two readers ask for it:
 *  the sandbox's structure gate, and the manager on the one path that does not dispatch a sandbox
 *  (domains/units/first-master.ts). A second literal would let the two ask for different files. */
export const CONSUMER_MANIFEST_PATH = "deploy/platform.yaml";

/** A GitHub account name (a user or an owner) as GitHub itself admits it: alphanumeric, a
 *  hyphen only between two alphanumerics, at most 39 characters. */
export const GITHUB_ACCOUNT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** DNS-1123 label, <= 40 chars. The identity law (G1) requires
 *  manifest name == chart name == repo name == unit, and the namespace is `<unit>-<stage>`
 *  (consumerNamespace below). Exported for the run kind that composes a unit name from a tenant's
 *  subdomain (tenant-apps-repo) and refuses one this grammar does not admit. */
export const consumerName = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/);

/** The unit's public host LABEL — one DNS label the unit stands on under its stage's zone,
 *  `<label>.<stage apex>` (plugins/unit/shared/unit-host.ts). Not the name: `digita-auth` is the identity, `auth` is
 *  what a person types. A stage word is refused because the stage words ARE the zones. */
export const hostLabel = z
  .string()
  .regex(HOST_LABEL_RE, "one DNS label: lower-case letters, digits and hyphens, at most 63 characters")
  .refine((l) => !RESERVED_HOST_LABELS.includes(l), { message: "a stage word cannot be a host label — the stage words are the zones" });

/** The backing services a consumer may request in its manifest (contract v1.3). THIS list is the
 *  vocabulary's one owner: the published schema restates it for the reader, and hostyour-cloud's
 *  consumer-contract census holds the two against each other in both directions. */
export const CONSUMER_SERVICE = ["mongodb", "postgresql", "redis", "registry-pull", "forwardauth", "postfix", "smtp-ops"] as const;
export const ConsumerServiceSchema = z.enum(CONSUMER_SERVICE);
export type ConsumerService = (typeof CONSUMER_SERVICE)[number];

/** A repo-relative chart directory path (never absolute — must not start with "/"). Mirrors the
 *  ConsumerRegistrationSchema.chartPath rule; reused by the tenant: fan-out block below. */
const chartPath = z.string().regex(/^[^/].*$/);

/** A public FQDN: two or more lowercase DNS-1123 labels. Shared by the manifest's declared `fqdn`
 *  and the registration's attested one, so the two ends of the grant validate identically. The
 *  character set (lowercase alphanumerics, `-`, `.`) is also what keeps the value safe to inline
 *  into the admission policy's CEL string literals. */
export const publicFqdn = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/);

/** A unit's SMTP submission entry: the ClusterIP Service of the MTA the unit brings, and the port it
 *  takes submissions on. Declared in the manifest and ATTESTED into the stage registration by the
 *  onboarding (gate G29 holds it to one sender per stage). The unit carrying it at a stage is that
 *  stage's mail sender: hostyour-cloud opens the entry on the unit's cluster, on that cluster's
 *  tailnet address only, and points the installation's own relay at it; the Mail page measures the
 *  address mail leaves from there (hostyour-cloud#242, hostyour-manager#249). */
export const SmtpEntrySchema = z.object({
  service: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
  // The port the MTA's pods listen on, which the Service exposes under the same number: the unit
  // fence admits the relay on it, and a NetworkPolicy port is the pod's, never the Service's.
  port: z.number().int().min(1).max(65535),
  // The declared secret the unit's MTA signs the platform domain's mail with — a `generate: rsa2048`
  // key of the same manifest. The Manager mints it at onboarding like every generated secret, seeds
  // the private half into the unit's Vault entry, and keeps the PUBLIC half on the unit's row, which
  // is what the Mail page publishes under `<stage>._domainkey.<platform domain>`. Absent, the unit
  // signs nothing for the platform domain and the page says so.
  dkimKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
});
export type SmtpEntry = z.infer<typeof SmtpEntrySchema>;

/** The manifest `tenant:` fan-out block — declared by a build-only fan-out repo
 *  (catalog) so the manager renders/validates the whole tenant package instead of one
 *  chart. Kept INLINE here (never in shared/tenant.ts) because ConsumerManifestSchema references it
 *  and gates.ts already imports consumer.ts: defining it in tenant.ts would close the cycle
 *  consumer -> tenant -> gates -> consumer. The acyclic order stays enums <- consumer <- gates <-
 *  tenant. `perApp.front.override` DATA-DRIVES the name-keyed chart swap (e.g. an app named `web`
 *  renders charts/example-web instead of the default front chart charts/example-ui). */
/** ONE chart render inside a member: the chart, the value files layered on top of the standard chain,
 *  and the values handed to it. A standing member has one; a per-app member has as many as the product
 *  declares under `perApp` (an engine and a front today).
 *
 *  `{app}` is the ONE token this schema defines, and it is substituted with the app's name when the
 *  Manager resolves a PER-APP source — in every valueFiles entry and in every string inside
 *  `values`. It exists because a per-app chart's file names and resource names are the product's own
 *  convention (`values-<app>.yaml`, a Service named after the app), and the alternative was the
 *  platform composing those names, which is the same defect one layer down. A standing member's
 *  source has no app, so nothing is substituted there. */
const TenantSourceSchema = z.object({
  chart: chartPath,
  /** Extra value files, repo-relative to the CHART directory, layered after the chart's own
   *  values.yaml and values-<stage>.yaml and before the cluster profile. */
  valueFiles: z.array(z.string().regex(/^[A-Za-z0-9._{}-]+\.ya?ml$/)).optional(),
  /** Values merged onto this source — the product's own keys, and the only place a chart-specific
   *  value name may appear. The tenant's own facts are NOT here: the appset hands every source the
   *  same `tenant` block (guid, subdomain, stage, member, appName, apps, seedUsers, suspended,
   *  quiesced) and each chart takes what it needs. */
  values: z.record(z.string(), z.unknown()).optional(),
});
export type TenantSource = z.infer<typeof TenantSourceSchema>;

/** ONE standing member of every tenant of this product — a member that exists whether or not the
 *  tenant selects any app, with its own namespace and its own AppProject.
 *
 *  A LIST, not a set of keys. The three that exist today were `trio: { auth, jobs, report }`, which
 *  made the member set a shape of THIS schema rather than data of the product declaring it: a fourth
 *  standing member could not be expressed at all, and the cloud base carried the names of one
 *  product's components. The cloud base states what a member IS; the tenant product states which
 *  ones it has.
 *
 *  `identityProvider` replaces the old `required: true` on auth, which nothing read. It marks the
 *  member the activation and relocation paths reach for the tenant's own IdP — the one thing about a
 *  member the platform genuinely has to know, and the only reason a member name was ever a constant
 *  here. Exactly one member carries it. */
export const TenantMemberSchema = TenantSourceSchema.extend({
  /** The member's name — the middle of its namespace, its AppProject and its Application, all
   *  `<guid>-<name>-<stage>`. Free text within the DNS-label grammar: the platform composes with it and
   *  never compares against a literal. */
  name: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/),
  /** The tenant's own IdP. Exactly one member declares it; create-tenant's activation and every
   *  relocation path resolve the IdP through this flag instead of through a hardcoded name. */
  identityProvider: z.boolean().optional(),
  /** Extra labels this member's namespace carries beyond the ones every tenant namespace gets — the
   *  data behind what would otherwise be an `if member == auth` in the appset (a redis consumer label). */
  namespaceLabels: z.record(z.string(), z.string()).optional(),
});

/** An https clone URL ending in `.git` — the shape every repository the tenant catalog names has. */
const gitRepoURL = z.string().regex(/^https:\/\/[^ ]+\.git$/);

export const TenantSpecSchema = z.object({
  // The members every tenant always has, one namespace + one AppProject each. No flag and no file
  // gates them: a tenant's apps require these services to exist.
  members: z.array(TenantMemberSchema).min(1),
  // The sources ONE selected app renders, in order. Every app of every tenant renders all of them;
  // `override` swaps a whole source for an app the product names (an app called `web` renders a
  // different front chart with different values from the operator apps).
  perApp: z.object({
    engine: TenantSourceSchema,
    front: TenantSourceSchema.extend({
      /** A complete replacement source, keyed by app name. Keyed lookup IS the selection: the appset
       *  never compares an app name against a literal, because the Manager has already resolved
       *  which source this app renders. */
      override: z.record(z.string(), TenantSourceSchema).optional(),
    }),
  }),
  /** WHICH REPOSITORY BUILDS WHICH IMAGE the member charts pull (`builds[].image` in their values),
   *  so the tenant onboarding can release the images its fan-out lacks the way a consumer onboarding
   *  releases its own (hostyour-manager#165). One entry per repository, every image name once; the
   *  unit a repository names is its basename (unitNameFromRepoURL), the identity every registration
   *  holds. */
  buildRepos: z.array(z.object({
    repo: gitRepoURL,
    builds: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
  })).default([]),
  /** THE GITHUB OWNER A TENANT'S OWN REPOSITORY IS CREATED IN, stated by the catalog because
   *  the catalog is the customer's: the platform's GitHub App is installed in exactly one
   *  owner (adapters/github-app installationOrg), and a plan whose catalog names another is
   *  refused rather than creating a repository where the App has no rights. GitHub's own grammar for
   *  an account name: letters, digits and single hyphens between them, at most 39 characters. */
  appsOrg: z.string().regex(GITHUB_ACCOUNT_RE, "appsOrg must be a GitHub owner name: letters, digits and single hyphens, at most 39 characters").optional(),
  /** THE APPS TEMPLATE: the name and the repository of the apps bundle a tenant's own apps
   *  repository is COPIED from. `appsRepo` is read with the catalog's own credential; its `apps.yaml`
   *  is the app catalog the wizard offers and T4 judges (shared/apps-manifest.ts). The template is
   *  NEVER a unit: the platform never builds it and no tenant mounts it, so a `buildRepos` entry
   *  that builds `appsBundle` is refused. Both absent ⇒ the catalog is the engine chart's
   *  `values-<app>.yaml` overlays, as before the manifest existed (server/domains/units/app-catalog.ts). */
  appsBundle: z.string().regex(/^[a-z0-9-]+$/).optional(),
  appsRepo: gitRepoURL.optional(),
  /** HOW THE PRODUCT ADDRESSES ITS MEMBERS below the zone (MEMBER_ROUTING, shared/enums.ts): `host`, a
   *  host of their own each, or `path`, every member under a path of the zone itself. The product
   *  says it because its charts are what route; the platform follows it with the DNS record and every
   *  member address it composes. Absent is `host`, the addressing before the field existed. */
  routing: z.enum(MEMBER_ROUTING).default("host"),
}).superRefine((spec, ctx) => {
  if ((spec.appsBundle === undefined) !== (spec.appsRepo === undefined)) {
    ctx.addIssue({ code: "custom", path: [spec.appsBundle === undefined ? "appsBundle" : "appsRepo"], message: spec.appsBundle === undefined
      ? `appsRepo ${spec.appsRepo} names no template — appsBundle is the template's name and is declared beside it`
      : `appsBundle "${spec.appsBundle}" has no appsRepo — the template's repository, whose apps.yaml is the app catalog, is declared beside it` });
  }
  const templateBuild = spec.buildRepos.find((b) => spec.appsBundle !== undefined && b.builds.includes(spec.appsBundle));
  if (templateBuild !== undefined) {
    ctx.addIssue({ code: "custom", path: ["buildRepos"], message: `buildRepos entry ${templateBuild.repo} builds "${spec.appsBundle}", the apps template — the platform never builds the template and no tenant mounts it; a tenant's own apps repository is copied from it` });
  }
  // Two invariants the list form has to carry that a keyed map would carry for free.
  const names = spec.members.map((m) => m.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) {
    ctx.addIssue({ code: "custom", path: ["members"], message: `two members are both named "${dup}" — a member's name IS its namespace and its AppProject suffix, so the second would land on the first` });
  }
  // EXACTLY one, never zero and never two. create-tenant's activation and every relocation path
  // resolve the tenant's IdP through this flag; with none they have nothing to reach, and with two
  // they would reach whichever the list happened to order first.
  const idps = spec.members.filter((m) => m.identityProvider === true).map((m) => m.name);
  if (idps.length !== 1) {
    ctx.addIssue({ code: "custom", path: ["members"], message: idps.length === 0
      ? `no member declares identityProvider: true — a tenant's activation and its relocations resolve the IdP through that flag and have nothing to reach without it`
      : `${idps.length} members declare identityProvider: true (${idps.join(", ")}) — exactly one is the tenant's IdP` });
  }
  const repos = spec.buildRepos.map((b) => b.repo);
  const dupRepo = repos.find((r, i) => repos.indexOf(r) !== i);
  if (dupRepo !== undefined) {
    ctx.addIssue({ code: "custom", path: ["buildRepos"], message: `buildRepos names ${dupRepo} twice — one entry per repository carries every image it builds` });
  }
  const images = spec.buildRepos.flatMap((b) => b.builds);
  const dupImage = images.find((n, i) => images.indexOf(n) !== i);
  if (dupImage !== undefined) {
    ctx.addIssue({ code: "custom", path: ["buildRepos"], message: `the image "${dupImage}" is named by two buildRepos entries — one repository builds one image` });
  }
});
export type TenantSpec = z.infer<typeof TenantSpecSchema>;

/** The apps template of a catalog — the bundle's name and the repository it is copied from — or
 *  null where the catalog declares none. The catalog reader (server/domains/units/app-catalog.ts)
 *  resolves the template through it; the plan holds the rendered images against the name alone
 *  (server/domains/units/tenant-builds.ts planBuildUnits). */
export function tenantAppsTemplate(spec: Pick<TenantSpec, "appsBundle" | "appsRepo">): { name: string; repo: string } | null {
  return spec.appsBundle !== undefined && spec.appsRepo !== undefined ? { name: spec.appsBundle, repo: spec.appsRepo } : null;
}

/** The owner the tenant repositories of this catalog are created in, or undefined where the
 *  catalog states none — the ONE reader of `appsOrg`, so a run kind and a gate ask the same question
 *  the same way. Nothing reads it yet: the run kind that creates a tenant repository is the first. */
export function tenantAppsOrg(spec: Pick<TenantSpec, "appsOrg">): string | undefined {
  return spec.appsOrg;
}

/** The unit a repository names — its basename without `.git` — the identity law every registration
 *  holds (`name == basename(repoURL)` below) and the name a tenant's build unit is registered under. */
export function unitNameFromRepoURL(repoURL: string): string {
  return repoURL.slice(repoURL.lastIndexOf("/") + 1).replace(/\.git$/, "");
}

/** One manifest secrets[] declaration (contract v1.3). `generate` marks a key the MANAGER
 *  mints at seed time (the operator is NEVER asked for it); a required key WITHOUT `generate` is
 *  operator-supplied. The mint kinds:
 *    hex32 / hex16 / uuid  — a single crypto-random value.
 *    rsa2048               — generate an RSA-2048 keypair; this key holds the PKCS#8 PEM private half.
 *    rsa2048-public        — this key holds the SPKI PEM public half of the keypair generated for the
 *                            key named in `pairWith` (so the two halves ALWAYS match — a JWT signer +
 *                            its JWKS cannot drift apart).
 *    deploy-git-credentials — DERIVED (not random) from the consumer's OWN repo PAT: the
 *                            https://oauth2:<pat>@github.com git-credentials line a consumer that writes
 *                            to a GitOps repo (e.g. example-plane -> catalog) reuses its ONE PAT
 *                            for, so the operator is never asked for a second deploy credential.
 *  Every minted value is verified (length / key size / PEM shape / private↔public match) before it is
 *  written. Exported so the onboard Run's frozen params carry the SAME shape (onboard.run.ts
 *  seed-secrets) AND the gate-runner validates against it — one schema, never two drifting. */
export const ConsumerSecretSpecSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string().optional(),
  required: z.boolean().default(true),
  generate: z.enum(["hex32", "hex16", "uuid", "rsa2048", "rsa2048-public", "deploy-git-credentials"]).optional(),
  // Only with generate:"rsa2048-public": names the sibling generate:"rsa2048" key this public half is
  // derived from. Validated at seed (fail-closed) — a dangling pairWith rejects the run.
  pairWith: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
});
export type ConsumerSecretSpec = z.infer<typeof ConsumerSecretSpecSchema>;

/** One operator-supplied dynamic argument for a post-onboard activation call.
 *  `field` is the request-body key (e.g. "email"); `label` is the human prompt the onboard
 *  wizard/approve renders. These are NOT secrets — they are collected in the clear at approve and
 *  passed in the activation call's body (an admin email is not a credential). */
export const ConsumerActivationPromptSchema = z.object({
  field: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/),
  label: z.string().min(1),
});

/** The OPTIONAL `activation:` block a consumer declares in deploy/platform.yaml:
 *  a manifest-declared post-onboard call the Manager makes over the consumer's OWN ingress
 *  once the app is serving — example-auth's first-admin bootstrap is the canonical case
 *  (POST /api/v1/bootstrap/invite-admin, gated by X-Bootstrap-Token, returns an activate_url).
 *
 *  The auth secret is NOT carried here — only the NAME of a seeded secret (`tokenSecret`) that holds
 *  the bootstrap token (minted by seed-secrets, kept in-run memory for the call, never persisted).
 *  `prompt[]` names the operator-supplied dynamic args the onboard collects at approve. Absent on a
 *  manifest ⇒ no activation, the onboard is unchanged (backward-compatible). */
export const ConsumerActivationSchema = z.object({
  // The request path on the consumer's public host, e.g. "/api/v1/bootstrap/invite-admin". Absolute.
  path: z.string().regex(/^\/\S*$/),
  method: z.literal("POST"),
  // The manifest secrets[] key that holds the auth token (e.g. "AUTH_BOOTSTRAP_TOKEN"). Must name a
  // declared, required secret so seed-secrets always has it to keep in-run memory for the call.
  tokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  // The header the token is sent under, e.g. "X-Bootstrap-Token".
  tokenHeader: z.string().regex(/^[A-Za-z0-9-]+$/),
  // The operator-supplied dynamic args (e.g. the admin email). May be empty (a fixed-body call).
  prompt: z.array(ConsumerActivationPromptSchema).default([]),
});
export type ConsumerActivation = z.infer<typeof ConsumerActivationSchema>;

/** The OPTIONAL `mail` object a consumer's activation endpoint MAY return alongside `activate_url`
 *: the outcome of the invite mail the endpoint tried to send, so the
 *  onboard `activate` step can surface delivery right next to the activate_url. Absent ⇒ the step logs
 *  no mail line and behaves EXACTLY as before (a consumer — or an older build — that returns no mail
 *  object). Consumer-agnostic: this is the platform activation contract, nothing example-auth-specific.
 *    sent    — delivered to the transport successfully.
 *    failed  — the send attempt failed (`detail` = a short reason).
 *    skipped — no real transport configured (a dev log-stub).
 *  `transport` names the send channel (e.g. "smtp", "ses", "log-stub"); `detail` is a short,
 *  human-readable note (present mainly on `failed`). */
export const ConsumerActivationMailSchema = z.object({
  status: z.enum(["sent", "failed", "skipped"]),
  transport: z.string(),
  detail: z.string().optional(),
});
export type ConsumerActivationMail = z.infer<typeof ConsumerActivationMailSchema>;

/** deploy/platform.yaml — what a consumer declares (contract v1.3). */
export const ConsumerManifestSchema = z.object({
  apiVersion: z.literal("hostyour.cloud/v1"),
  kind: z.literal("ConsumerManifest"),
  name: consumerName,
  // The public host label, `<host>.<stage apex>`; absent, the unit stands on its name. Declared
  // and then ATTESTED into the stage registration by the onboarding, which holds it against every
  // other label and every tenant subdomain under the same zone (gate G23).
  host: hostLabel.optional(),
  owner: z.string().min(1),
  envs: z.array(z.enum(STAGE)).min(1),
  // v1.3: chart is OPTIONAL — present = self-contained (the repo carries its own deploy); absent =
  // build-only (the deploy is central, in catalog). Presence is the sole shape discriminator.
  chart: z.object({ path: z.string().min(1) }).optional(),
  services: z.array(ConsumerServiceSchema).default([]),
  // The LITERAL Mongo database name(s) the consumer's provisioned ServiceClaim creates. Declared
  // VERBATIM in deploy/platform.yaml (e.g. ["example_auth"]) as the SINGLE source of truth — one
  // entry, no env-suffix, no prefix composition. Copied unchanged into the registration
  // (ConsumerRegistration.databases) so the consumers ApplicationSet injects it as mongodb.databases and
  // the service-provisioner creates EXACTLY these names. Empty [] ⇒ the consumer requests no database.
  databases: z.array(z.string()).default([]),
  // The LITERAL redis key patterns this consumer's ACL user is granted, each written as redis writes
  // one after `~` (`example:auth:*`). The SIBLING of `databases` above, and for the same reason: one
  // redis serves every consumer of a cluster out of ONE keyspace, so a pattern is a claim on a
  // shared name the way a database name is. Copied VERBATIM into the registration, injected by the
  // consumers ApplicationSet as `redis.keyPatterns`, granted EXACTLY as stated by the
  // service-provisioner, and held to this set by the unit's own admission fence — so a chart cannot
  // ask for a pattern the platform never granted it (simetrixch/hostyour-cloud#199).
  //
  // REQUIRED FOR A REDIS CLAIM AND FAIL-CLOSED, which the ServiceClaim CRD states and this mirrors:
  // an ACL user must be told which keys it may touch, and the answer for a claim naming none is an
  // error rather than every key. Empty [] ⇒ this consumer claims no redis, which is most of them.
  keyPatterns: z.array(z.string()).default([]),
  // The LITERAL redis Pub/Sub channel patterns this consumer's ACL user is granted, each written
  // as redis writes one after `&` (`example:notify:*`). A channel is not a key: a user granted
  // `~example:*` still gets NOPERM on PUBLISH and SUBSCRIBE, because the ACL user starts with
  // `resetchannels` and only a `&` rule opens one. Same path as `keyPatterns`: copied VERBATIM
  // into the registration, injected as `redis.channelPatterns`, granted EXACTLY as stated by the
  // service-provisioner, held to this set by the fence. Empty [] ⇒ no channel, the default that
  // every consumer standing before the field ran with (#195).
  channelPatterns: z.array(z.string()).default([]),
  // HOW this consumer runs MongoDB. `shared` (the default) means the cluster's own replica set, the
  // one every tenant uses. The other two give it an instance of its OWN, in its own namespace, and
  // the difference between them is capability rather than price: a `standalone` is ONE member and
  // MongoDB serves NO TRANSACTIONS from one, so it fits an application that does not need them and
  // nothing of this platform's own. `replicaset` is three members and costs three times as much.
  //
  // It says WHAT, never how big — the databases run at the consumer's own size, which the operator
  // sets. That is why no size field stands beside it: a unit has ONE size, and a second size field is
  // a second answer to a question already answered.
  mongodb: MongodbModeSchema.default("shared"),
  // The OPTIONAL extra public FQDN the consumer serves under IN ADDITION to `<label>.<stage apex>`
  // — never instead: one Ingress, two spec.rules entries, told apart by the Host header. Declaring is
  // not granting: the onboard run kind ATTESTS the value into the stage registration (the builds[]
  // declare-and-attest shape), and the admission policy admits only the ATTESTED value, so a
  // manifest naming a foreign FQDN gets nothing. The platform never verifies domain control and
  // creates no DNS record for it — the customer points their DNS here, or the name does not resolve.
  fqdn: publicFqdn.optional(),
  // The OPTIONAL SMTP submission entry of the MTA this unit brings (SmtpEntrySchema above). Declaring
  // it makes the unit its stage's mail sender, attested at onboarding, and one per stage (G29).
  smtpEntry: SmtpEntrySchema.optional(),
  builds: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9-]+$/),
        containerfile: z.string().min(1),
        // Build context dir, repo-relative. Optional: the platform convention is
        // a Dockerfile under docker/ that builds from the REPO ROOT (COPY paths
        // are root-relative), so it defaults to "." — NOT the containerfile's own
        // directory. A consumer with a self-contained subdir build sets it here.
        context: z.string().min(1).optional(),
      }),
    )
    .default([]),
  secrets: z.array(ConsumerSecretSpecSchema).default([]),
  // v1.3 fan-out — a build-only fan-out repo (catalog) declares the tenant package it
  // deploys per-tenant. OPTIONAL so zod does NOT strip the block: omitting the field would
  // silently drop the fan-out (the exact example-plane failure mode this design fixes). There is
  // no tenant `kind` — chart-presence + this block are the shape discriminators.
  tenant: TenantSpecSchema.optional(),
  // v1.3 — an OPTIONAL manifest-declared post-onboard activation. Absent
  // ⇒ no activation step, the onboard is unchanged. OPTIONAL so zod does NOT strip a declared block.
  activation: ConsumerActivationSchema.optional(),
  // A TENANT'S OWN APPS BUNDLE: this build is the bundle a tenant's engines mount, and its pin is
  // `appsImageTag` on every tenant registration whose `appsImage` names it — never a chart's
  // builds[] and never a pins file. Written by the Manager into `<bundle>-<subdomain>` (tenant-apps-tree.ts
  // tenantAppsManifest) and read by the release pipeline's bump, which pins the image on those
  // registrations (class d) and accepts a release no registration names yet, because the run
  // creating the tenant reads the tag off that release's PipelineRun (hostyour-cloud#225). The same
  // word as the catalog's `tenant.appsBundle`, which names the TEMPLATE's build; here it names one of
  // this manifest's own builds[]. Build-only by nature: refused beside `chart` or `tenant`.
  appsBundle: z.string().regex(/^[a-z0-9-]+$/).optional(),
})
  .superRefine((m, ctx) => {
    if (m.appsBundle !== undefined) {
      if (!m.builds.some((b) => b.name === m.appsBundle)) {
        ctx.addIssue({ code: "custom", path: ["appsBundle"], message: `appsBundle "${m.appsBundle}" names no build of this manifest — it says which of builds[] is the tenant's apps bundle` });
      }
      if (m.chart || m.tenant) {
        ctx.addIssue({ code: "custom", path: ["appsBundle"], message: "appsBundle is declared by a build-only manifest — a tenant's apps bundle deploys no chart of its own and fans nothing out" });
      }
    }
    // C1 — a manifest must deploy: a chart (self-contained), a non-empty builds[], OR a tenant: fan-out
    // block (a pure fan-out repo like catalog carries neither chart nor builds — the tenant block
    // IS its deploy). A file with none of the three is inert.
    if (!m.chart && m.builds.length === 0 && !m.tenant) {
      ctx.addIssue({ code: "custom", path: ["chart"], message: "a manifest must declare a chart, a non-empty builds[], or a tenant: fan-out block — this one declares none" });
    }
    // C3 — build names (== image names) must be unique within the manifest.
    const names = m.builds.map((b) => b.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", path: ["builds"], message: "builds[].name must be unique within the manifest" });
    }
    // C4 — a fan-out repo (tenant: present) deploys OTHER units; it never deploys itself as one
    // chart, so a self-contained chart alongside a tenant: block is a contradiction.
    if (m.tenant && m.chart) {
      ctx.addIssue({ code: "custom", path: ["tenant"], message: "a manifest that declares a tenant: fan-out block must not also declare its own chart — the fan-out repo deploys others, never itself as one chart" });
    }
    // The extra FQDN rides the unit's own Ingress, so only a manifest WITH a chart can serve it — a
    // build-only or fan-out manifest deploys no Ingress of its own to carry the second rule, and a
    // declared name that could never serve would sit unread forever.
    if (m.fqdn !== undefined && !m.chart) {
      ctx.addIssue({ code: "custom", path: ["fqdn"], message: "fqdn requires a chart — only a self-contained (deployable) unit has an Ingress of its own to serve a second FQDN" });
    }
    // The entry names a Service of the unit's own chart, so only a unit that deploys one can declare it.
    if (m.smtpEntry !== undefined && !m.chart) {
      ctx.addIssue({ code: "custom", path: ["smtpEntry"], message: "smtpEntry requires a chart — only a self-contained (deployable) unit runs the MTA whose Service it names" });
    }
    // The DKIM key is minted as a declared secret, so it must be one: a generate:"rsa2048" key here.
    const dkimKey = m.smtpEntry?.dkimKey;
    if (dkimKey !== undefined && !m.secrets.some((s) => s.key === dkimKey && s.generate === "rsa2048")) {
      ctx.addIssue({ code: "custom", path: ["smtpEntry", "dkimKey"], message: `smtpEntry.dkimKey "${dkimKey}" names no generate:"rsa2048" secret in secrets[] — the Manager mints the signing key as that declared secret` });
    }
    // a declared activation must point its tokenSecret at a REQUIRED declared secret. seed-secrets
    // keeps that secret's value in-run memory for the activation call; if it named an absent or optional
    // key, the token could be missing at call time (a dangling reference, exactly like pairWith). The
    // fields it prompts for must be uniquely named (they become body keys).
    if (m.activation) {
      const named = m.secrets.find((s) => s.key === m.activation!.tokenSecret);
      if (!named) {
        ctx.addIssue({ code: "custom", path: ["activation", "tokenSecret"], message: `activation.tokenSecret "${m.activation.tokenSecret}" names no secret declared in secrets[] — it must reference the seeded key that holds the auth token` });
      } else if (named.required === false) {
        ctx.addIssue({ code: "custom", path: ["activation", "tokenSecret"], message: `activation.tokenSecret "${m.activation.tokenSecret}" must be a required secret — an optional key may be unseeded, leaving the activation call without its token` });
      }
      const fields = m.activation.prompt.map((p) => p.field);
      if (new Set(fields).size !== fields.length) {
        ctx.addIssue({ code: "custom", path: ["activation", "prompt"], message: "activation.prompt[].field must be unique — each becomes a body key" });
      }
    }
  });
export type ConsumerManifest = z.infer<typeof ConsumerManifestSchema>;

/** The NAMESPACE of one consumer AT ONE STAGE: `<name>-<stage>`, prod included. A unit carries its
 *  own stage, so two stages of one unit may stand in one installation — on one cluster even — and
 *  the bare name would put them into one namespace with one host and one certificate. Every writer
 *  of the namespace composes it here: the AppProject destination, the admission policy's namespace
 *  clause, the smoke check, the namespace delete, the mail-ops grant's subject. The consumers
 *  ApplicationSet (hostyour-cloud clusters/argocd/files/consumers-appset.yaml) stamps the same
 *  string, so a second spelling anywhere would deploy into a namespace nothing fences. */
export function consumerNamespace(consumerName: string, stage: Stage): string {
  return `${consumerName}-${stage}`;
}

/** The label a manifest puts its unit on — `host` where it declares one, the name otherwise. Read
 *  ONCE at the onboarding and attested into the stage registration; everything after reads the
 *  registration or the inventory row, never the manifest again. */
export function consumerHostLabel(manifest: { name: string; host?: string | undefined }): string {
  return manifest.host ?? manifest.name;
}

/** The NAME of the Application the consumers ApplicationSet generates from a registration — the
 *  same string as the namespace, `<name>-<stage>` (e.g. "example-auth-prod"), never the bare consumer
 *  name. Every Manager watch on the generated Application (onboard watch-sync, offboard
 *  watch-removal, suspend/resume) MUST derive the name here, or it polls a CR that never exists. */
export function consumerArgoAppName(consumerName: string, stage: Stage): string {
  return consumerNamespace(consumerName, stage);
}

/** The ArgoCD UI deep-link for a consumer's generated Application. The master's own ArgoCD is served
 *  at `argo.<masterFqdn>` with its Application CRs in ns "argocd"; a slave's per-slave ArgoCD instance
 *  runs ON the master at `argo-<slaveName>.<masterFqdn>` with CRs in ns == the slave name. Because the
 *  Application always lives in the SAME namespace as its own ArgoCD instance, the plain
 *  `/applications/<appName>` path resolves in both — no `/applications/<ns>/<name>` qualifier needed.
 *  `argoNamespace` is the resolver's value ("argocd" for the master self-cluster, the slave name
 *  otherwise). Returns null when the master FQDN is unknown, so the caller renders no link rather than
 *  a broken one. */
export function consumerArgocdUrl(masterFqdn: string | null, argoNamespace: string, appName: string): string | null {
  if (!masterFqdn) return null;
  const host = argoNamespace === "argocd" ? `argo.${masterFqdn}` : `argo-${argoNamespace}.${masterFqdn}`;
  return `https://${host}/applications/${appName}`;
}

/** registrations/<unit>/{<stage>|build}.yaml — what the platform REGISTERS about a unit. It carries
 *  only OURS, never three owners' worth in one file. The consumer's own pin (its commit SHA, its
 *  image tags) is not here at all — the Application follows the delivery branch `deploy/<stage>` as a
 *  literal, and the cluster's own values reach every chart from its values chain.
 *
 *  TWO FORMS, cut at FIELD level and told apart by the presence of the deploy group:
 *    build.yaml   — stage-free, EVERY unit has one. Carries `builds[]`, the ATTESTED build names, and
 *                   NEVER a deploy-group field. "build-only" means build.yaml present AND no stage file.
 *    <stage>.yaml — a DEPLOYABLE unit's per-stage file. Carries the deploy group
 *                   (chartPath/cluster/databases/services) and never `builds[]`.
 *
 *  `suspended`, `quiesced` and `removing` are MANDATORY with default false and are written explicitly
 *  on every commit, so a chart may read the two pauses BARE under `missingkey=error` without a `dig`
 *  and the ApplicationSet selects on the third; `services` is mandatory in the deployable form (an
 *  empty list is fine) for the same reason — a fourth Application source gates on it.
 *
 *  A FIELD ADDED HERE HAS A DEFAULT, AND THE BOOT WRITES IT: the Manager's boot parses every standing
 *  registration through this schema and commits the ones whose serialized form differs
 *  (plugins/unit/server/registrations-migration.ts), so a standing unit meets a new key at the next
 *  boot rather than at a hand. A field the schema cannot fill by itself — required, no default — is
 *  a run kind's job, never a boot's; an optional one, where absent is a meaning, stays absent.
 *
 *  The invariant `name == basename(repoURL)` is what makes the split safe: with ONE writer plus this
 *  invariant, the `repoURL` in a unit's build.yaml and in its stage files cannot contradict itself. */
export const ConsumerRegistrationSchema = z
  .object({
    name: consumerName,
    repoURL: z.string().regex(/^https:\/\/[^ ]+\.git$/),
    // No credential id: the repository is reached with the owner's identity, resolved from the URL
    // at every use (server repo-identity.ts, hostyour-manager#226). A registration written before
    // that carries a `repoCredentialId` this schema strips.
    owner: z.string().optional(),
    onboardedAt: z.string().optional(),
    suspended: z.boolean().default(false), // the off state the chart renders: replicas 0, no Ingress
    quiesced: z.boolean().default(false), // the deeper pause a removal-in-flight holds a unit in
    // The removal itself, in flight: offboard, purge and the onboard abort write it true BEFORE the
    // file goes, and the consumers ApplicationSet — the one generator that selects on it — drops the
    // Application while the AppProject and the fence, generated off the same file, still stand
    // (hostyour-cloud#213). Nothing reads it as a chart value, and nothing writes it back to false.
    removing: z.boolean().default(false),
    // ---- the deploy group: present TOGETHER in a stage file, absent TOGETHER from build.yaml ----
    chartPath: z.string().regex(/^[^/].*$/).optional(),
    // The cluster this stage's Application lands on, by its SHORT NAME (clusterShortName of the
    // cluster's FQDN, e.g. "m1") — the appset's post-selector matches on it. Any active cluster: the
    // stage is the unit's own, stated by this file's path, and the cluster's map says nothing about it.
    cluster: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/).optional(),
    // The cluster a MOVE is taking this stage away from, by its short name, standing from the repoint
    // until clear-source. The delivery ApplicationSet selects on `cluster` alone and prunes the
    // source Application at once; the two fence ApplicationSets select on `cluster` OR `leaving`, so
    // the source keeps the AppProject that deletion needs until the Application is gone
    // (hostyour-cloud#214). Absent outside a move.
    leaving: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/).optional(),
    // The LITERAL Mongo database name(s) copied VERBATIM from ConsumerManifest.databases — the
    // registration is the outward projection the consumers ApplicationSet reads to set
    // mongodb.databases, so the service-provisioner creates EXACTLY these names (no prefix, no
    // env-suffix, no composition). An empty list ⇒ the consumer requests no database.
    databases: z.array(z.string()).optional(),
    // The redis key patterns copied VERBATIM from ConsumerManifest.keyPatterns — the outward
    // projection the consumers ApplicationSet reads to set `redis.keyPatterns`, and the units
    // ApplicationSet to set the fence's granted set. Optional because a registration written before
    // the field existed is still a valid registration; ABSENT reads as granted NOTHING, never as
    // granted everything, which is also what a unit claiming no redis carries.
    keyPatterns: z.array(z.string()).optional(),
    // The redis channel patterns copied VERBATIM from ConsumerManifest.channelPatterns, optional for
    // the same reason and with the same reading: ABSENT is granted NO channel (#195).
    channelPatterns: z.array(z.string()).optional(),
    // The backing services the consumer CLAIMS, copied VERBATIM from ConsumerManifest.services.
    // Distinct from `databases` on purpose: `databases` is engine-neutral (a consumer may reuse it for
    // Postgres db names), so it cannot be the switch that decides whether the platform renders a
    // per-consumer PostgreSQL instance — only an explicit `postgresql` in `services` can.
    services: z.array(ConsumerServiceSchema).optional(),
    // The unit's own size, copied here so the ApplicationSet can name the database preset from it
    // (values-size-<size>.yaml) — the same word that sized the application. Part of the deploy group
    // and therefore always present in a stage registration: the appset reads it bare, so an absent
    // one is a render failure rather than a silent fall back to a size nobody chose.
    size: UnitSizeSchema.optional(),
    // How this consumer runs MongoDB, copied VERBATIM from the manifest. The appset gates its
    // conditional MongoDB source on it, and the quota above was summed from it.
    mongodb: MongodbModeSchema.optional(),
    // The six figures that bound this consumer's namespace, resolved by the Manager from its size
    // table when it writes the registration (plugins/unit/server/unit-size.ts resolveUnitQuota) and
    // passed straight through to hostyour-cloud/apps/unit-quota by the ApplicationSet.
    //
    // The NUMBERS and not a size NAME, deliberately. A name would have to be resolved on the cluster
    // side, and the table it resolves against lives in the Manager's database, which no cluster can
    // read; putting the table in git instead is what branch-classes.yaml rules out, since a file that
    // both ships with the product and gets edited in service cannot be one path. So the registration
    // states what the unit gets — as literally as it states its databases and its services — and the
    // cost is that changing the table rewrites the registrations that stood on it, one visible commit
    // each.
    //
    // Part of the deploy group: a stage registration always carries it, and the ApplicationSet reads
    // it bare, so an absent one is a render failure rather than a namespace with no ceiling.
    quota: UnitQuotaSchema.optional(),
    // The ATTESTED public host label — what the manifest declared as `host`, or the unit's name where
    // it declared none — copied here by the onboarding after gate G23 held it against the zone. The
    // consumers ApplicationSet composes `unitHost` from it and the fence pins that host; nothing
    // reads the manifest for it again. Part of the deploy group: a stage registration always carries
    // it, because the Application it generates always serves a host.
    host: hostLabel.optional(),
    // The ATTESTED extra public FQDN — the onboard run kind copies the manifest's `fqdn` here AFTER
    // refusing a name the platform already serves. The admission policy and the consumer chart read
    // THIS value, never the manifest, which is what makes declaring different from being granted.
    // OPTIONAL even in the stage form (most units serve only `<label>.<stage apex>`), so it stands
    // OUTSIDE the deploy group's stands-or-falls rule; never in build.yaml (checked below).
    fqdn: publicFqdn.optional(),
    // The ATTESTED SMTP submission entry — the onboard run kind copies the manifest's `smtpEntry`
    // here after G29 held the stage to one sender. hostyour-cloud renders the entry and the relay's
    // forward from THIS value, and the Mail page detects the stage's sender by it. Optional in the
    // stage form, like `fqdn`, and never in build.yaml.
    smtpEntry: SmtpEntrySchema.optional(),
    // ---- build.yaml only ----
    // The ATTESTED build names of this unit — what the build fan-out renders one pipeline per, and the
    // set G16 holds a candidate unit's declared builds against. A build name IS the image name (flat,
    // no unit segment), and the tag is the release pipeline's to mint, so neither belongs in a file we
    // write.
    builds: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
  })
  .superRefine((e, ctx) => {
    // The identity invariant: a unit is NAMED by its repo. The webhook that triggers a build resolves
    // the unit from the pushed repo URL through exactly this equality, so a divergence would route a
    // consumer's push at another unit's pipeline.
    const base = e.repoURL.slice(e.repoURL.lastIndexOf("/") + 1).replace(/\.git$/, "");
    if (base !== e.name) {
      ctx.addIssue({ code: "custom", path: ["name"], message: `name "${e.name}" must equal basename(repoURL) ("${base}")` });
    }
    // Field-level exclusivity. `cluster` is the discriminator: with it, this is a stage file and the
    // WHOLE deploy group must stand (services included, possibly empty — a chart source gates on it
    // bare); without it, this is build.yaml and no deploy-group field may appear.
    const deployGroup = ["chartPath", "cluster", "databases", "services", "size", "mongodb", "quota", "host"] as const;
    if (e.cluster === undefined) {
      for (const k of deployGroup) {
        if (e[k] !== undefined) {
          ctx.addIssue({ code: "custom", path: [k], message: `"${k}" is a deploy-group field and may not appear in a build registration` });
        }
      }
      if (e.builds === undefined) {
        ctx.addIssue({ code: "custom", path: ["builds"], message: "a build registration must carry builds[] (an empty list when the unit builds nothing)" });
      }
      if (e.fqdn !== undefined) {
        ctx.addIssue({ code: "custom", path: ["fqdn"], message: "fqdn belongs in a stage registration — build.yaml describes no serving surface" });
      }
      if (e.smtpEntry !== undefined) {
        ctx.addIssue({ code: "custom", path: ["smtpEntry"], message: "smtpEntry belongs in a stage registration — build.yaml describes no serving surface" });
      }
      return;
    }
    for (const k of deployGroup) {
      if (e[k] === undefined) {
        ctx.addIssue({ code: "custom", path: [k], message: `"${k}" is required in a stage registration — the whole deploy group stands or falls together` });
      }
    }
    if (e.builds !== undefined) {
      ctx.addIssue({ code: "custom", path: ["builds"], message: "builds[] belongs in the stage-free build registration, never in a stage registration" });
    }
  });
export type ConsumerRegistration = z.infer<typeof ConsumerRegistrationSchema>;

/** A registration read out of a STAGE file, with the deploy group narrowed to present. The schema
 *  refuses a stage form without it, but the two forms share one object type, so a reader that has
 *  ESTABLISHED it holds a stage registration says so with this type instead of falling back per field. */
export type ConsumerStageRegistration = Omit<ConsumerRegistration, "chartPath" | "cluster" | "databases" | "services" | "size" | "mongodb" | "quota" | "host"> & {
  chartPath: string;
  host: string;
  cluster: string;
  databases: string[];
  services: ConsumerService[];
  size: UnitSize;
  mongodb: MongodbMode;
  quota: UnitQuota;
};
