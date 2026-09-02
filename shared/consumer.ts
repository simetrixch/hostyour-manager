// Consumer contract types (v1.3) — the TypeScript mirror of the JSON Schemas that live in
// hostyour-cloud `docs/consumer-contract/`. Kept in shared/ so the gate-runner, the onboarding
// domain, and the web card all agree on one shape. The vendored JSON Schemas remain the
// authoritative contract; hostyour-cloud's tools/checks/consumer-contract.census.sh hashes them and
// fails when this mirror drifts.
import { z } from "zod";
import { UnitQuotaSchema, UnitSizeSchema, MongodbModeSchema, type UnitQuota, type UnitSize, type MongodbMode } from "./unit-size.ts";
import { STAGE, type Stage } from "./enums.ts";

/** WHERE a consumer repository keeps its manifest. One spelling, because two readers ask for it:
 *  the sandbox's structure gate, and the manager on the one path that does not dispatch a sandbox
 *  (domains/units/first-master.ts). A second literal would let the two ask for different files. */
export const CONSUMER_MANIFEST_PATH = "deploy/platform.yaml";

/** DNS-1123 label, <= 40 chars. The identity law (G1) requires
 *  name == namespace == Chart.name == pointer name. */
const consumerName = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/);

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
const publicFqdn = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/);

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
  /** The member's name — its Application suffix, its namespace suffix and its AppProject suffix, all
   *  `<guid>-<name>`. Free text within the DNS-label grammar: the platform composes with it and
   *  never compares against a literal. */
  name: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/),
  /** The tenant's own IdP. Exactly one member declares it; create-tenant's activation and every
   *  relocation path resolve the IdP through this flag instead of through a hardcoded name. */
  identityProvider: z.boolean().optional(),
  /** Extra labels this member's namespace carries beyond the ones every tenant namespace gets — the
   *  data behind what would otherwise be an `if member == auth` in the appset (a redis consumer label). */
  namespaceLabels: z.record(z.string(), z.string()).optional(),
});

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
}).superRefine((spec, ctx) => {
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
});
export type TenantSpec = z.infer<typeof TenantSpecSchema>;

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
  // The OPTIONAL extra public FQDN the consumer serves under IN ADDITION to `<name>.<unitApex>` —
  // never instead: one Ingress, two spec.rules entries, told apart by the Host header. Declaring is
  // not granting: the onboard run kind ATTESTS the value into the stage registration (the builds[]
  // declare-and-attest shape), and the admission policy admits only the ATTESTED value, so a
  // manifest naming a foreign FQDN gets nothing. The platform never verifies domain control and
  // creates no DNS record for it — the customer points their DNS here, or the name does not resolve.
  fqdn: publicFqdn.optional(),
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
})
  .superRefine((m, ctx) => {
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

/** The NAME of the Application the consumers ApplicationSet generates from a pointer: the appset
 *  template stamps `{{ .name }}-<stage>` (hostyour-cloud argocd/<stage>/apps/consumers-appset.yaml),
 *  e.g. "example-auth-prod" — NOT the bare consumer name. Every Manager watch on the generated
 *  Application (onboard watch-sync, offboard watch-removal, suspend/resume) MUST derive the name
 *  here, or it polls a CR that never exists. The AppProject/namespace stay the bare name (G1). */
export function consumerArgoAppName(consumerName: string, stage: Stage): string {
  return `${consumerName}-${stage}`;
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
 *  `suspended` and `quiesced` are MANDATORY with default false and are written explicitly on every
 *  commit, so a chart may read them BARE under `missingkey=error` without a `dig`; `services` is
 *  mandatory in the deployable form (an empty list is fine) for the same reason — a fourth Application
 *  source gates on it.
 *
 *  The invariant `name == basename(repoURL)` is what makes the split safe: with ONE writer plus this
 *  invariant, the `repoURL` in a unit's build.yaml and in its stage files cannot contradict itself. */
export const ConsumerRegistrationSchema = z
  .object({
    name: consumerName,
    repoURL: z.string().regex(/^https:\/\/[^ ]+\.git$/),
    // the credential-store id of the private repo's read credential; omitted = public.
    repoCredentialId: z.string().optional(),
    owner: z.string().optional(),
    onboardedAt: z.string().optional(),
    suspended: z.boolean().default(false), // the off state the chart renders: replicas 0, no Ingress
    quiesced: z.boolean().default(false), // the deeper pause a removal-in-flight holds a unit in
    // ---- the deploy group: present TOGETHER in a stage file, absent TOGETHER from build.yaml ----
    chartPath: z.string().regex(/^[^/].*$/).optional(),
    // The cluster this stage's Application lands on, by its SHORT NAME (clusterShortName of the
    // cluster's FQDN, e.g. "m1") — the appset's post-selector matches on it. A registration for
    // stage X may only name a cluster MARKED X; that boundary is enforced at the writer.
    cluster: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/).optional(),
    // The LITERAL Mongo database name(s) copied VERBATIM from ConsumerManifest.databases — the
    // registration is the outward projection the consumers ApplicationSet reads to set
    // mongodb.databases, so the service-provisioner creates EXACTLY these names (no prefix, no
    // env-suffix, no composition). An empty list ⇒ the consumer requests no database.
    databases: z.array(z.string()).optional(),
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
    // table when it writes the registration (domains/units/unit-size.ts resolveUnitQuota) and
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
    // The ATTESTED extra public FQDN — the onboard run kind copies the manifest's `fqdn` here AFTER
    // refusing a name the platform already serves. The admission policy and the consumer chart read
    // THIS value, never the manifest, which is what makes declaring different from being granted.
    // OPTIONAL even in the stage form (most units serve only `<name>.<unitApex>`), so it stands
    // OUTSIDE the deploy group's stands-or-falls rule; never in build.yaml (checked below).
    fqdn: publicFqdn.optional(),
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
    const deployGroup = ["chartPath", "cluster", "databases", "services", "size", "mongodb", "quota"] as const;
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
export type ConsumerStageRegistration = Omit<ConsumerRegistration, "chartPath" | "cluster" | "databases" | "services" | "size" | "mongodb" | "quota"> & {
  chartPath: string;
  cluster: string;
  databases: string[];
  services: ConsumerService[];
  size: UnitSize;
  mongodb: MongodbMode;
  quota: UnitQuota;
};
