import { z } from "zod";
import { UnitSizeSchema, DEFAULT_UNIT_SIZE } from "../../../shared/unit-size.ts";
import { resolveUnitQuota } from "./unit-size.ts";
import { and, eq } from "drizzle-orm";
import type { RunDefinition, Step, StepCtx, Plan } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { clusters, tenants, tenantApps } from "../../db/schema/inventory.ts";
import { tenantId as mintTenantRowId, tenantAppId as mintTenantAppId, mintTenantGuid } from "../../kernel/ids.ts";
import { STAGE, type Stage, type TenantStatus } from "../../../shared/enums.ts";
import { guid as guidSchema, memberName, TenantAppSchema, TenantMemberRecordSchema, TenantRegistrationSchema, TenantValidationReportSchema, type TenantRegistration } from "../../../shared/tenant.ts";
import { AppError, errNotFound, errValidation } from "../../kernel/errors.ts";
import { localTx } from "../../executor/stepkit.ts";
import { validateTenant } from "./validate-tenant.ts";
import { RequiredImageSchema, requiredImagesFrom, ensureImagesStep } from "./ensure-images.ts";
import { clusterShortName } from "../inventory/cluster-marking.ts";
import { assertDeployState } from "./lifecycle.ts";
import { renderTenantAppProject } from "./appproject.ts";
import { renderTenantMemberAdmissionPolicy, tenantMemberAdmissionPolicyName } from "./admission-policy.ts";
import { renderTenantArgoSync, tenantSyncUnits } from "./build-rbac.ts";
import { CATALOG_CHART_BRANCH, type TenantRegistrations } from "./tenant-registrations.ts";
import { memberNamespace, tenantApplicationSet } from "./tenant-fanout.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { mintTenantCrypto, TENANT_CRYPTO_PROPERTIES } from "./tenant-crypto-mint.ts";
import { STORAGE_SECRET_PREFIX, STORAGE_ENDPOINT_FIELD, readTenantStorage } from "./tenant-storage.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";
import { registryHostFromChain } from "./tenant-values.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";
import type { RepoReader } from "../../adapters/git/port.ts";
import type { HelmRenderer } from "../../adapters/helm/port.ts";
import type { Activator } from "../../adapters/activation/port.ts";
import type { RegistryProbe } from "../../adapters/registry/port.ts";
import type { BuildRbacWriter, ClusterKubeResolver } from "../../adapters/kube/port.ts";
import { syncedAt, describeUnsynced } from "./tenant-watch.ts";
import { provisionUnitDns, tenantWildcardHost } from "./unit-dns.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import { tenantActivateStep } from "./create-tenant-activate.ts";
import { createTenantCleanups, assertCreateTenantAbortable } from "./create-tenant-abort.ts";
import { ensureSubdomainFreeStep, resolveReplaceTargets, ReplaceTargetSchema } from "./tenant-replace.ts";
import { tenantTeardownSteps, REPLACE_TEARDOWN } from "./tenant-teardown.ts";

// The "create-tenant" Run — the tenant analogue of
// onboard.run.ts. Instead of pinning one consumer chart it fans a single registration out to one
// SELF-CONTAINED member per trio service and per app: each with its own namespace <guid>-<member>, its
// own AppProject and its own Application. Everything not per-member — the tenant's Vault path, its
// databases, its crypto — is either claimed by the member chart that needs it (ServiceClaims) or
// written by this run itself (the tenant's crypto entry in Vault).
// It shares onboard's streaming-plan skeleton: the plan phase runs the long fan-out validation
// (validate-tenant.ts) gate-by-gate against the approve card, freezes the composed report + resolved
// pin into params, and settles planned/failed — so plan() is a guard (see planStream).
//
// mutating: true ⇒ guards.assertGuardsArmed requires steps()[0] === "attest-target". The
// Manager acts master-locally, so the git/helm/kube clients ride in TenantOnboardPorts.
// Two-repo wiring: registrations is the TenantRegistrations bound to catalog (a SECOND
// PlatformRepo, distinct workRoot), never the consumer Registrations. v1 seeds NO secrets
// (requiredSecrets=[]) — a tenant's charts pull from Vault via ExternalSecret.

/** The Manager-side clients the tenant steps drive (master-local; no SSH). The same port
 *  set backs add-app.run.ts. registrations is the TenantRegistrations, sole writer of tenants/** on
 *  catalog; helm renders the trusted first-party charts manager-side (no sandbox). */
export interface TenantOnboardPorts {
  repo: RepoReader;
  helm: HelmRenderer;
  registrations: TenantRegistrations;
  /** Per-cluster kube resolver: the steps resolve the target cluster's
   *  clusterReader/argoReader/projectWriter + ArgoCD namespace at run time (tenants land only on
   *  slaves per POLICY). Replaces the single argo/cluster/projects clients. */
  resolver: ClusterKubeResolver;
  catalogRepoUrl: string; // the platform constant every tenant's charts live in
  /** The platform GitOps repo (hostyour-cloud). A member Application pulls its chart from catalog
   *  and its `$values` chain from here, so the member's AppProject must allow both or ArgoCD rejects
   *  the sync. */
  platformRepoURL: string;
  catalogCredentialId?: string; // the manager's first-party catalog read credential
  argoWatchTimeoutMs: number;
  /** The ensure-images gate: probes the target cluster's registrations for every image the pinned fan-out pulls,
   *  BEFORE any pointer/project mutation, so onboarding never fans out to an image that does not
   *  exist. A missing image fails the run — tenant onboarding never builds one. */
  registryProbe: RegistryProbe;
  /** Writes the tenant's argo-sync Role + RoleBinding. The member AppProjects blacklist both kinds,
   *  so no tenant chart can render them and the Manager is the only writer left — the same reason
   *  the consumer onboard writes its build grants imperatively. */
  buildRbac: BuildRbacWriter;
  /** Every `<unit, build>` pair attested on the registration branch (Registrations.listAttestedBuildNames).
   *  A build name is the flat image repository, so this is what turns the images a tenant pulls into
   *  the build namespaces whose release pipelines may sync it (tenantSyncUnits). */
  attestedBuilds: () => Promise<{ unit: string; build: string }[]>;
  /** Every unit that holds a registration (Registrations.listUnitNames). The subdomain belt refuses a
   *  subdomain that is one of them: the consumer of that name serves `<name>.<unitApex>`, which is
   *  the host this tenant's IdP would scope its session cookies to (unit-dns.ts). */
  consumerNames: () => Promise<string[]>;
  /** Makes the tenant first-admin invite call (create-tenant-activate.ts) over the tenant's public
   *  example-auth ingress. Optional: only the `activate` step needs it, and only when the operator
   *  supplied an admin email — a tenant onboarded without one never touches this port. Supplied WITH an
   *  admin email but absent ⇒ the step fails loud (a wiring gap, never a silent skip). It is the SAME
   *  HttpActivator instance the consumer onboard uses (wire-units.ts). */
  activator?: Activator;
  /** The tenant's ONE wildcard DNS record `*.<subdomain>.<unitApex>` (provision-dns).
   *  Optional but UNCONDITIONALLY needed by that step — absent ⇒ it fails loud (DNS is a mandatory
   *  part of the run kind), never a silent skip. */
  dns?: DnsProvider;
  /** The public apex (global.unitApex) of the target cluster, read off its values chain on the
   *  platform repo — the tenant family's own repo is catalog, so the apex arrives as a
   *  resolver (the cluster-stage boundary's shape). */
  resolveUnitApex: (domain: string, stage: Stage) => Promise<string>;
  /** The target cluster's values chain off its install branch, read ONCE per plan and folded two
   *  ways: the registry host the fan-out's images are probed in (registryHostFromChain — the
   *  chain's profile carries zot.<build-plane>, so a cluster whose images are built on a foreign
   *  build plane resolves THAT registrations, never the master's), and the values every member chart is
   *  RENDERED with (the tenant appsets layer this same chain at deploy, and example-lib.image
   *  requires global.endpoints.registrations.host from it — without the chain no member render can even
   *  resolve an image ref). */
  resolveClusterValueFiles: (domain: string, stage: Stage) => Promise<ClusterValueFile[]>;
  /** Writes the tenant's crypto entry `<stage>/tenants/<guid>` — the ONE Vault leaf every member
   *  namespace of this tenant reads through its own SecretStore. The SAME seeder the consumer onboard
   *  seeds through, over the Manager's own write-only Vault identity. Optional only because a
   *  Manager without Vault is a real state (a dev process, the checks); absent ⇒ the seed step fails
   *  loud, never silently produces a tenant whose members cannot resolve a single secret. */
  seeder?: VaultSeeder;
}

const GUID_MINT_ATTEMPTS = 8; // CSPRNG guid space is 32^12; a live collision is astronomically unlikely

/** The reset nonce a fresh tenant starts at, in its registration. It used to ride the Tenant CR's
 *  operator.hostyour.cloud/reset annotation as well, where a CHANGED value told the reconciler to drop the
 *  tenant's databases and restart its pods so the boot-seeds repopulate. That reconciler is gone and
 *  the CR with it, so the field is written and nothing acts on a change to it — a data reset has no
 *  mechanism today. The field stays because it is a mandatory part of the registration schema and
 *  whatever answers "what is a data reset" will key on it. */
const INITIAL_RESET_NONCE = "1";

// Mirror of shared/tenant.ts:subdomain (not exported) — a bounded, zero-PII public DNS-subdomain
// label. TenantRegistrationSchema re-validates it at write-registration, so this is only the early
// wizard guard.
const subdomainSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/);

/** The frozen create-tenant params: the operator's fields + everything the streaming plan resolved
 *  (the minted guid, the pinned chartsRef, the approved report, the frozen expected-Application set). */
export const CreateTenantParams = z.object({
  guid: guidSchema, // minted + collision-checked at plan time; the sole tenant identity (<guid>)
  subdomain: subdomainSchema,
  stage: z.enum(STAGE),
  clusterId: z.string().startsWith("cls_"), // which cluster the tenant runs on (crypto-gate keyed here)
  domain: z.string().min(1),
  // The ArgoCD-registered slave NAME (resolveCluster; e.g. "s1") — the pointer's `cluster`
  // field AND the AppProject destination `name:` pin, distinct from `domain` (the host zone).
  cluster: z.string().min(1),
  // The catalog revision this run VALIDATED at — a run fact, not a registration field: the
  // frozen expectedApps/requiredImages below were computed from exactly this tree, so the run
  // record keeps the revision they are readable against.
  chartsRef: z.string().regex(/^[0-9a-f]{40}$/),
  // The registry host the fan-out's images are pulled from and probed against — the target
  // cluster's own chain (ports.resolveClusterValueFiles -> registryHostFromChain), frozen at plan time.
  registryHost: z.string().min(1),
  // Per-app seed tiers via TenantAppSchema: seedReference (→ SEED_APP_DATA_ON_BOOT) +
  // seedDemo (→ SEED_DEMO_DATA_ON_BOOT), both default false. Round-trips through tenant.yaml; legacy
  // pointers ({name} or {name, seed}) fold unchanged.
  apps: z.array(TenantAppSchema).default([]),
  // EVERY member this tenant gets, resolved at validation time and CARRIED: the step list is built
  // from params alone (the armed check calls def.steps({})). The standing members and the app members
  // are one list here — an app is a member — and `apps` above says which of them came from an app.
  members: z.array(TenantMemberRecordSchema).min(1), identityProvider: memberName,
  seedUsers: z.boolean().default(false), // flips the tenant IdP's user boot-seed; a registration field
  // The tenant's SIZE — the ceiling EVERY member namespace of it is bounded by. A NAME here, resolved
  // to figures as the registration is written, so a plan that waited for approval across a table edit
  // lands on the figures standing at that moment. Defaulted to the frugal preset like the consumer
  // form: an unattended path must never sell the generous one by omission.
  size: UnitSizeSchema.default(DEFAULT_UNIT_SIZE),
  owner: z.string().min(1),
  report: TenantValidationReportSchema, // the approved fan-out report — the run record keeps it verbatim
  expectedApps: z.array(z.string()), // == tenantApplicationSet(guid,apps,stage); the set-watch pivot
  // The registrations images the pinned fan-out pulls (the validated render's container images filtered
  // to registryHost, requiredImagesFrom) — frozen at plan time like expectedApps;
  // the ensure-images step probes/builds exactly this set BEFORE write-pointer. pipeline null ⇒
  // probe-only (a consumer-built image tenant onboarding must never build).
  requiredImages: z.array(RequiredImageSchema).default([]),
  // The build units whose release pipelines the argo-sync grant arms — the units that attest a build
  // name one of requiredImages carries (tenantSyncUnits), resolved at plan time from the SAME frozen
  // image set, so the grant and the images it follows can never be computed from two different trees.
  syncUnits: z.array(z.string()).default([]),
  catalogRepoUrl: z.string().min(1),
  // The operator's OPTIONAL first-admin email (the create-tenant wizard field). Threaded ONLY so the
  // final `activate` step can invite the tenant's first admin; deliberately NOT written to the
  // registration, the inventory, or the checkpoint (PII hygiene) — it lives only here in the run params
  // + that one transient invite call. Absent ⇒ the invite is skipped and the tenant onboards as before.
  adminEmail: z.string().email().optional(),
  // Idempotent-by-subdomain: the existing same-subdomain tenants this create-tenant
  // must REPLACE (offboard first) — frozen at plan time so steps() prepends the SAME offboard steps at
  // execute/resume. Empty (the normal case) ⇒ no offboard steps, a plain onboard.
  replaces: z.array(ReplaceTargetSchema).default([]),
});
export type CreateTenantParams = z.infer<typeof CreateTenantParams>;

/** The raw operator request from the create-tenant wizard (before the plan mints the guid + resolves
 *  the pin/report). stage + domain are derived from the target cluster row, never trusted from input. */
export const CreateTenantRequest = z.object({
  clusterId: z.string().startsWith("cls_"),
  subdomain: subdomainSchema,
  owner: z.string().min(1),
  // Per-app seed tiers — each selected app's Reference + Demo checkboxes. Absent ⇒ both false.
  apps: z.array(TenantAppSchema).default([]),
  seedUsers: z.boolean().default(false),
  // The tenant's size — the ceiling each of its member namespaces gets. From the OPERATOR creating
  // the tenant, the same way the consumer form takes it from the operator onboarding the unit.
  size: UnitSizeSchema.default(DEFAULT_UNIT_SIZE),
  // OPTIONAL first-admin email (the wizard's "Admin email" field). Empty ⇒ omitted; when present the
  // deploy gains the first-admin invite. Kept out of the registration/inventory — see CreateTenantParams.
  adminEmail: z.string().email().optional(),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

/** WHICH of create-tenant's two inventory writes is running. Named once, as one value, so it can never
 *  degenerate into a pair of booleans a caller could combine into a nonsense state:
 *   - "provisional" — record-provisional, BEFORE any mutation: records INTENT (status "provisioning").
 *   - "settled"     — record-inventory, after the fan-out is live: records SUCCESS (status "active"). */
type TenantRecordPhase = "provisional" | "settled";

/** The ONE writer of the tenants + tenant_apps rows, shared by both record steps so "what the run
 *  intends" and "what the run achieved" can never drift into two different row shapes. Overwrite-
 *  idempotent on (clusterId, guid) and (tenantId, name), in ONE tx so a crash leaves it resumable: every
 *  DESCRIPTIVE column (the subdomain, the seed flag, the owner) is rewritten in both phases, because a
 *  resume must converge the row onto the params it is actually running.
 *
 *  The row's LIFECYCLE STATE is the deliberate exception — `status` plus `suspended`, which is its flat
 *  projection for the appset selector and which tenant-suspend/-resume move in lock-step with it, so the
 *  two are written as ONE unit and never separately. That unit is written on INSERT in both phases, but
 *  on UPDATE only when SETTLING. A resumed run re-runs record-provisional against a row record-inventory
 *  may ALREADY have lifted to "active" (or a later tenant-suspend moved to "suspended"), and demoting a
 *  live tenant back to "provisioning" would paint it as unfinished, hide its live actions behind the
 *  provisional refusals and pull it out of the reconciliation view. Insert-only is therefore not an
 *  optimisation, it is the correctness rule.
 *  Returns the tenants row id (the caller logs it — it is the handle every removal run kind needs). */
function upsertTenantInventory(ctx: StepCtx, p: CreateTenantParams, phase: TenantRecordPhase): string {
  const settle = phase === "settled";
  const status: TenantStatus = settle ? "active" : "provisioning";
  const lifecycle = { status, suspended: false }; // the unit above — a fresh tenant is never suspended
  return localTx(ctx, (tx) => {
    const existing = tx.select().from(tenants).where(and(eq(tenants.clusterId, p.clusterId), eq(tenants.guid, p.guid))).get();
    const values = {
      clusterId: p.clusterId, guid: p.guid, subdomain: p.subdomain, stage: p.stage,
      // Every later path that reaches the IdP holds a row, not the manifest.
      //
      // The row records the STANDING members only, which is why the app names are filtered out: an
      // app's presence is the tenant_apps row and its status, and a member list that also carried the
      // apps would drift the moment one was offboarded. Every reader unions the two (tenantWatchSet,
      // the tenant card, the relocation world), so the app names are never lost — they are just kept
      // where their status lives. Derived from the two fields rather than carried as a third, which
      // could drift out of step with them.
      identityProvider: p.identityProvider, members: p.members.map((m) => m.name).filter((n) => !p.apps.some((a) => a.name === n)),
      seedUsers: p.seedUsers,
      owner: p.owner, provenance: "controller" as const,
      lastRunId: ctx.runId, updatedAt: new Date(),
    };
    const rowId = existing?.id ?? mintTenantRowId();
    if (existing) tx.update(tenants).set({ ...values, ...(settle ? lifecycle : {}) }).where(eq(tenants.id, existing.id)).run();
    else tx.insert(tenants).values({ id: rowId, ...values, ...lifecycle }).run();
    for (const a of p.apps) {
      const ex = tx.select().from(tenantApps).where(and(eq(tenantApps.tenantId, rowId), eq(tenantApps.name, a.name))).get();
      if (ex) tx.update(tenantApps).set({ lastRunId: ctx.runId, ...(settle ? { status } : {}) }).where(eq(tenantApps.id, ex.id)).run();
      else tx.insert(tenantApps).values({ id: mintTenantAppId(), tenantId: rowId, name: a.name, status, lastRunId: ctx.runId }).run();
    }
    return rowId;
  });
}

function createTenantSteps(ports: TenantOnboardPorts, p: CreateTenantParams): Step[] {
  // Every member of this tenant, standing ones first then one per app. One namespace and one
  // AppProject per entry — the tenant owns several of each, never one shared pair. Read defensively
  // because the armed check evaluates def.steps({}) with NO params at all.
  const members = (p.members ?? []).map((m) => m.name);
  const namespaces = members.map((m) => memberNamespace(p.guid, m));
  // Idempotent-by-subdomain: PREPEND the shared teardown steps for each existing same-subdomain
  // tenant AFTER attest-target (which must stay step 0) and record-provisional (which must
  // precede every mutation, and a teardown git-rm's a pointer), and BEFORE the onboard proper — so the
  // old tenant is fully pruned before the fresh guid deploys onto the shared public FQDN. The REPLACE
  // flavour is fail-loud: a fan-out that will not prune STOPS this run rather than let two tenants
  // serve the one FQDN. Empty ⇒ a plain onboard; steps({}) has no replaces ⇒ step 0 stays
  // attest-target (assertGuardsArmed).
  // Empty `cascade` for the same reason the abort teardown has one: a replace issues no cluster-side
  // delete of its own, so the old tenant's identity (namespaces, Vault crypto entry) stands and
  // only tenant-purge deletes any of it. Its member databases go with the prune's ServiceClaim
  // deletions regardless — the plan summary warns the operator before approval.
  const replaceSteps = (p.replaces ?? []).flatMap((t) => tenantTeardownSteps(ports, t, REPLACE_TEARDOWN, []));
  return [
    {
      name: "attest-target",
      title: "Attest the target cluster (deploy-state fresh)",
      run: async (ctx) => {
        // Fail closed on an absent/drifted deploy-state (shared assertDeployState, lifecycle.ts).
        // Read it on the TARGET cluster's own reader (a slave over its bearer).
        const { clusterReader } = await ports.resolver.resolve(p.clusterId);
        const state = assertDeployState(await clusterReader.readDeployState(), p.domain, p.stage, "tenant");
        ctx.log("meta", `target ${p.domain} (${p.stage}) attested for ${p.guid} — deploy-state generation ${state.generation}`);
      },
    },
    // The execute-time subdomain belt (tenant-replace.ts): a concurrent create-tenant that took the
    // subdomain after this plan froze its replace set stops the run here, before any write.
    ensureSubdomainFreeStep(ports.registrations, ports.consumerNames, p),
    {
      name: "record-provisional",
      title: "Record the tenant as provisioning (before anything is deployed)",
      run: async (ctx) => {
        // THE ROOT-CAUSE FIX. The tenants row used to be written LAST, so it
        // recorded SUCCESS while git and the cluster had already been mutated several steps earlier: a
        // failure in between left a tenant that exists in GitOps + ArgoCD but has NO tenants row, and
        // EVERY removal run kind resolves its target BY that row (lifecycle.ts loadTenantCluster throws
        // NOT_FOUND) — so the tenant was not merely broken, it was unreachable through the product.
        // Recording INTENT here, right after the attest and the subdomain belt (both read-only) and
        // therefore before ANY git or kube mutation (the replace teardowns git-rm pointers,
        // ensure-images creates PipelineRuns),
        // means there is always a row to name; record-inventory only settles it to "active".
        //
        // Arm the compensation in the same breath: from the moment the Manager commits to this
        // tenant, the shared teardown IS its registered inverse. Registering all four from ONE step is
        // also what fixes their order — abortWithCleanup reverses across STEPS, not within one, and
        // collects a single step's cleanups in registration order — so they run remove -> watch-prune ->
        // delete-project -> record, the order tenant-offboard runs them in. Arming them before anything
        // is deployed costs nothing, because every one of them is idempotent: the pointer removal skips
        // an absent tenant.yaml, the prune wait passes at once on a fan-out that never existed, and the
        // project delete tolerates an absent project.
        for (const c of createTenantCleanups(ports, p)) ctx.registerCleanup(c);
        const rowId = upsertTenantInventory(ctx, p, "provisional");
        ctx.checkpoint({ tenantId: rowId, status: "provisioning" });
        ctx.log("meta", `tenant ${p.guid} recorded as provisioning on cluster ${p.clusterId} (${rowId}) — the row exists BEFORE any mutation, so a run that dies leaves a tenant the Manager can still name`);
      },
    },
    ...replaceSteps,
    {
      name: "seed-tenant-crypto",
      title: "Seed the tenant's crypto entry in Vault (create-only)",
      run: async (ctx) => {
        // The five values that ARE this tenant's identity, into the ONE entry every member namespace
        // reads: <stage>/tenants/<guid>. STRICTLY BEFORE write-registration, for the same reason
        // ensure-images is: the moment the registration lands, the fan-out generates every member
        // Application, and each one's ExternalSecrets resolve against this entry. Seeding after would
        // fan out into pods that cannot start and ExternalSecrets that report SecretSyncedError.
        //
        // CREATE-ONLY (cas=0, in the seeder). The mint below is unconditional — it always produces
        // fresh values — so the WRITE is what makes a re-run safe: an existing entry is left exactly
        // as it stands and the run says so. Anything else would rotate a live tenant's signing key
        // and bootstrap token out from under pods that read their env once, at container start.
        //
        // The minted values are never logged, never checkpointed and never returned: the Manager
        // holds no read grant on this path, so after this step nothing in the product can recover
        // them — which is the property the write-only policy exists to have.
        if (!ports.seeder) throw errValidation("no Vault seeder is wired — a tenant's crypto entry cannot be written, and without it every member's ExternalSecrets fail to resolve");
        // The three storage values ride in the SAME write as the minted crypto: one entry, one
        // cas=0 create, no second grant and no second path. Read here rather than at plan time
        // because a plan carries no secret — approve is where the operator hands them over.
        const storage = readTenantStorage(ctx);
        const { created } = await ports.seeder.seedTenantCrypto({
          stage: p.stage, guid: p.guid, data: { ...mintTenantCrypto(), ...storage },
        });
        ctx.checkpoint({ tenantCrypto: p.guid, created });
        ctx.log(
          "meta",
          created
            ? `entry ${p.stage}/tenants/${p.guid} created (${TENANT_CRYPTO_PROPERTIES.length} minted + 3 supplied properties) — the JWT keypair its IdP signs with, the TOTP key, the bootstrap token, the engine key, and the object storage the operator handed over`
            : `crypto entry ${p.stage}/tenants/${p.guid} already exists and was left UNTOUCHED — a re-run never rotates a live tenant's keys out from under its running pods`,
        );
      },
    },
    // The image gate, strictly BEFORE apply-appproject/write-pointer: every image the pinned
    // fan-out pulls from the target cluster's registrations must EXIST before the pointer lands, or the
    // appset fans out straight into ImagePullBackOff. A probe — a missing image fails the run naming
    // every absent tag, and nothing is built here.
    ensureImagesStep(ports, p),
    {
      name: "apply-appprojects",
      title: "Apply the per-member isolation AppProjects and admission policies",
      run: async (ctx) => {
        // ONE AppProject PER MEMBER, all of them BEFORE the registration: every generated member
        // Application references .spec.project == <guid>-<member>, and ArgoCD rejects an Application
        // whose project is absent. Each project permits exactly its own member namespace, so a member's
        // Application cannot deploy into a sibling. Beside each project, the member's
        // ValidatingAdmissionPolicy on the TARGET cluster (the policy is cluster-scoped, so it rides
        // the clusterReader where the project rides the master's projectWriter): the project
        // whitelists the Namespace kind so ArgoCD can create the destination namespace, and the
        // policy is what holds that grant to the member's own name and the platform's own stamped
        // labels. No registerCleanup here — the whole inverse
        // (registration removal, prune wait, project + policy deletes, row flip) was armed as ONE shared
        // teardown back at record-provisional, so it can never again run half of itself in the wrong order.
        // Idempotent on resume (both writers replace each object in place).
        const { projectWriter, clusterReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
        for (const member of members) {
          const project = renderTenantAppProject({
            guid: p.guid,
            member,
            argoNamespace,
            catalogRepoUrl: p.catalogRepoUrl,
            platformRepoURL: ports.platformRepoURL,
            cluster: p.cluster,
          });
          await projectWriter.applyAppProject(argoNamespace, project);
          const { policy, binding } = renderTenantMemberAdmissionPolicy({ guid: p.guid, member, stage: p.stage });
          await clusterReader.applyAdmissionPolicy(policy, binding);
        }
        ctx.checkpoint({ appProjects: namespaces, admissionPolicies: members.map((m) => tenantMemberAdmissionPolicyName(p.guid, m)) });
        ctx.log(
          "meta",
          `${members.length} AppProject(s) + admission policies applied (${namespaces.join(", ")}) — each member is isolated to its own namespace, destination pinned to ${p.cluster}, and its Namespace objects may carry no platform label beyond the stamped set`,
        );
      },
    },
    {
      name: "provision-argo-sync",
      title: "Provision the tenant's scoped argo-sync grant",
      run: async (ctx) => {
        // Beside the AppProjects and before the registration, in the same ArgoCD namespace: the grant
        // is what lets a release of a platform unit sync the pin it just bumped into this tenant,
        // instead of leaving the new image to ArgoCD's next poll. resourceNames name THIS tenant's
        // member Applications and no others, so a release syncing one tenant cannot touch a sibling.
        // No registerCleanup — the shared teardown armed at record-provisional deletes it beside the
        // member AppProjects. Idempotent on resume (the writer replaces both objects in place).
        const { argoNamespace } = await ports.resolver.resolve(p.clusterId);
        const syncGrant = renderTenantArgoSync({ guid: p.guid, applications: p.expectedApps, argoNamespace, units: p.syncUnits });
        const { created } = await ports.buildRbac.applyBuildRbac([syncGrant]);
        ctx.checkpoint({ argoSync: `${argoNamespace}/${syncGrant.role.metadata.name}`, units: p.syncUnits, created });
        ctx.log(
          "meta",
          p.syncUnits.length > 0
            ? `argo-sync grant ${syncGrant.role.metadata.name} applied in ${argoNamespace} over ${p.expectedApps.length} Application(s) — the release pipelines of ${p.syncUnits.join(", ")} may sync this tenant and no other`
            : `argo-sync grant ${syncGrant.role.metadata.name} applied in ${argoNamespace} over ${p.expectedApps.length} Application(s) with NO subject — no registered unit attests a build this tenant pins, so every bump reaches it on ArgoCD's own poll`,
        );
      },
    },
    {
      name: "provision-dns",
      title: "Provision the tenant's public DNS record",
      run: async (ctx) => {
        // ONE wildcard record per unit: every member sits exactly one level below
        // <subdomain>.<unitApex> (auth., erp., web., …; nothing lives on the bare <subdomain>), so
        // `*.<subdomain>.<unitApex>` covers them all — members added later included — and a move
        // changes one record. The idempotent-by-subdomain replace needs no removal of its own: the
        // replacing tenant carries the SAME subdomain, so this upsert re-points the standing record.
        const unitApex = await ports.resolveUnitApex(p.domain, p.stage);
        await provisionUnitDns(ctx, { dns: ports.dns, unit: p.guid, recordName: tenantWildcardHost(p.subdomain, unitApex), clusterFqdn: p.domain });
      },
    },
    {
      name: "write-registration",
      title: "Commit the tenant registration (GitOps deploy)",
      run: async (ctx) => {
        // The inverse is already armed (record-provisional registered the shared teardown, whose first
        // step git-rm's exactly this file). ONE file per tenant per stage; the gate report is NOT
        // written to git (it lives in this run's record). Overwrite-idempotent on resume;
        // TenantRegistrationSchema.parse re-validates as a belt, and commitTenant enforces the stage
        // boundary against the target cluster's own marking.
        const registration: TenantRegistration = TenantRegistrationSchema.parse({
          cluster: p.cluster,
          subdomain: p.subdomain,
          // As the approved validation froze them: this copy is the one the CHARTS read, and it must
          // say what the tenant WAS created with, not what the manifest says when it is read back.
          members: p.members, identityProvider: p.identityProvider,
          apps: p.apps,
          // Resolved HERE, at write time, against the size table as it stands now — see the params
          // field above. Per MEMBER: every member namespace of this tenant gets this ceiling.
          quota: resolveUnitQuota(ctx.db, p.size, {
            // A tenant brings no database of its own: its members claim the cluster's shared MongoDB
            // replica set, and no tenant runs a PostgreSQL. So its quota is the base row alone.
            postgresql: false, mongodb: "shared",
          }),
          seedUsers: p.seedUsers,
          resetNonce: INITIAL_RESET_NONCE,
          suspended: false,
          quiesced: false,
        });
        const { commit } = await ports.registrations.commitTenant({ stage: p.stage, guid: p.guid, registration, runId: ctx.runId });
        ctx.checkpoint({ commit, registration: `registrations/${p.guid}/${p.stage}.yaml` });
        ctx.log("meta", `tenant registration committed to catalog (${commit}) — the ArgoCD on ${p.cluster} will now generate + sync the fan-out`);
      },
    },
    {
      name: "watch-sync-set",
      title: "Wait for ArgoCD to sync the whole fan-out at the pinned commit",
      run: async (ctx) => {
        // The completeness gate: wait for EVERY expected Application (frozen at plan time from
        // tenantApplicationSet — a name ArgoCD never creates hangs forever) to appear AND converge
        // Synced/Healthy. Filtered by platform/tenant=<guid>; an absent member reads Missing.
        const until = syncedAt(p.expectedApps);
        const { argoReader, argoNamespace } = await ports.resolver.resolve(p.clusterId);
        const byName = await argoReader.watchApplicationSet(argoNamespace, p.expectedApps, until, {
          timeoutMs: ports.argoWatchTimeoutMs,
          signal: ctx.signal,
          labelSelector: `platform/tenant=${p.guid}`,
        });
        if (!until(byName)) throw errValidation(describeUnsynced(p.expectedApps, byName));
        ctx.log("meta", `all ${p.expectedApps.length} fan-out Application(s) are Synced + Healthy`);
      },
    },
    {
      name: "smoke",
      title: "Smoke-check every tenant member namespace",
      run: async (ctx) => {
        // Each member is a namespace of its own, so each is smoked on its own and the FIRST one that is
        // not healthy fails the run naming it. A green fan-out with one member's ExternalSecrets stuck
        // is a half-onboarded tenant, and rolling the members into one verdict would hide which.
        const { clusterReader } = await ports.resolver.resolve(p.clusterId);
        let workloads = 0;
        for (const ns of namespaces) {
          const smoke = await clusterReader.smoke(ns);
          if (!smoke.namespaceExists) throw errValidation(`namespace ${ns} does not exist after sync`);
          const failing = smoke.workloads.filter((w) => !w.available);
          if (failing.length) {
            throw errValidation(`workloads not available in ${ns}: ${failing.map((w) => `${w.kind}/${w.name}${w.message ? ` (${w.message})` : ""}`).join(", ")}`);
          }
          if (!smoke.externalSecretsReady) {
            throw errValidation(`ExternalSecrets are not all Ready in ${ns} — that member's secrets did not materialize`);
          }
          workloads += smoke.workloads.length;
        }
        ctx.checkpoint({ namespaces, workloads, externalSecretsReady: true });
        ctx.log("meta", `smoke ok across ${namespaces.length} member namespace(s) — ${workloads} workload(s) available, external secrets ready`);
      },
    },
    {
      name: "record-inventory",
      title: "Record the tenant in inventory",
      run: async (ctx) => {
        // SETTLE what record-provisional recorded: the SAME upsert, now writing status "active" on
        // insert AND update — this is the step that lifts the provisioning tenant row and its app rows
        // to live. It still inserts from scratch when no row is there, so it remains correct on its own
        // (a run resumed from a database restored before record-provisional ran).
        upsertTenantInventory(ctx, p, "settled");
        ctx.log("meta", `tenant ${p.guid} recorded as active on cluster ${p.clusterId} with ${p.apps.length} app(s) (provenance manager)`);
      },
    },
    // The first-admin invite — a FINAL step (after the tenant is serving + recorded, so a failed invite
    // never rolls back a live deployment). Always appended so the plan/step list is stable; it fires the
    // invite only when the operator supplied an admin email, otherwise it logs a skip (impl:
    // create-tenant-activate.ts, mirroring the consumer's onboard-activate.ts).
    tenantActivateStep(ports, p),
  ];
}

interface ResolvedCluster {
  clusterId: string;
  domain: string;
  stage: Stage;
  /** The cluster's SHORT NAME (clusterShortName of its domain, e.g. "s1") — populates the
   *  pointer's `cluster` field and the AppProject destination pin. */
  cluster: string;
}

/** Resolve the target cluster's context from its row — stage/domain are the cluster's, never trusted
 *  from wizard input (the registration path registrations/<guid>/<stage>.yaml depends on it). Also surfaces the
 *  cluster's SHORT NAME — the ArgoCD destination identity the pointer and the AppProject pin
 *  against. A tenant is placed on ANY active cluster whatever role it carries; the cluster must be
 *  ACTIVE, because a tenant that is not yet (or no longer) reachable cannot be created on it. */
function resolveCluster(db: Db, clusterId: string): ResolvedCluster {
  const row = db
    .select({ id: clusters.id, domain: clusters.domain, stage: clusters.stage, status: clusters.status })
    .from(clusters)
    .where(eq(clusters.id, clusterId))
    .get();
  if (!row) throw errNotFound(`cluster ${clusterId}`);
  if (row.status !== "active") throw errValidation(`cluster ${clusterId} is not active (status "${row.status}")`);
  return { clusterId: row.id, domain: row.domain, stage: row.stage, cluster: clusterShortName(row.domain) };
}

/** Mint a guid the registrations tree does not already hold at this stage. The 32^12 CSPRNG space makes
 *  a first-try free guid overwhelmingly likely; exhausting the bounded retry is INTERNAL (never reuse). */
async function mintFreeGuid(ports: TenantOnboardPorts, stage: Stage): Promise<string> {
  for (let i = 0; i < GUID_MINT_ATTEMPTS; i++) {
    const candidate = mintTenantGuid();
    // The question is only "does a registrations/<candidate>/<stage>.yaml stand", so this reads through
    // the TOLERANT scan and treats ABSENT as the one answer that means the guid is FREE. The strict
    // readTenant THROWS on a body it cannot parse — failing an entire create-tenant plan over a
    // candidate it should simply have discarded — while its null covers only an absent file.
    // "unreadable" means the guid IS taken (a file stands at that path), so the loop moves on and the
    // guid is never handed out twice.
    if ((await ports.registrations.scanTenant(stage, candidate)).status === "absent") return candidate;
  }
  throw new AppError("INTERNAL", `could not mint a free tenant guid after ${GUID_MINT_ATTEMPTS} attempts`);
}

export function makeCreateTenantDef(ports: TenantOnboardPorts): RunDefinition<CreateTenantParams> {
  return {
    kind: "create-tenant",
    paramsSchema: CreateTenantParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target, asserted at registrations boot
    plan: () => {
      // create-tenant is planned by the streaming planner (fan-out validation), never plan().
      throw new AppError("INTERNAL", "create-tenant is planned via planStream (the streaming entrypoint), not plan()");
    },
    // Streaming planner: resolve cluster -> mint+collision-check guid -> clone catalog -> render
    // + T1..T4 the fan-out (validate-tenant.ts), streamed gate-by-gate. A pass freezes the augmented
    // params (incl expectedApps=tenantApplicationSet) + plan; a rejection freezes the full report
    //.
    planStream: async (rawParams, ctx) => {
      const req = CreateTenantRequest.parse(rawParams);
      const rc = resolveCluster(ctx.db, req.clusterId);
      const clusterValueFiles = await ports.resolveClusterValueFiles(rc.domain, rc.stage);
      const registryHost = registryHostFromChain(clusterValueFiles);
      const guid = await mintFreeGuid(ports, rc.stage);
      const outcome = await validateTenant(
        {
          repoURL: ports.catalogRepoUrl,
          ref: CATALOG_CHART_BRANCH,
          stage: rc.stage,
          apps: req.apps,
          probeGuid: guid,
          clusterValueFiles,
          ...(ports.catalogCredentialId ? { credentialId: ports.catalogCredentialId } : {}),
        },
        { repo: ports.repo, helm: ports.helm, log: ctx.log, signal: ctx.signal },
      );
      if (outcome.verdict !== "pass") {
        const failed = outcome.report.gates.filter((g) => g.status !== "pass");
        return {
          outcome: "rejected",
          summary: `Tenant "${req.subdomain}" was rejected — ${failed.length} gate(s) did not pass: ${failed.map((g) => g.id).join(", ")}`,
          planJson: outcome.report,
        };
      }
      // Idempotent-by-subdomain: resolve the existing same-subdomain tenants to REPLACE — the union
      // of the DB inventory + a GitOps pointer scan (the scan also reaps ORPHANS), deduped by guid.
      const replaces = await resolveReplaceTargets({ db: ctx.db, registrations: ports.registrations }, rc.stage, req.subdomain);
      const expectedApps = tenantApplicationSet(outcome.memberRecords.map((m) => m.name), guid, rc.stage);
      // Freeze the ensure-images set alongside expectedApps: the validated render's container
      // images, filtered to the target cluster's registry host. The validated revision is frozen
      // into chartsRef as well, so the set cannot move between plan + execute.
      const requiredImages = requiredImagesFrom(outcome.images, registryHost);
      // The argo-sync grant's subjects, from the same frozen image set: which units BUILD what this
      // tenant pulls is read off the registration branch, so no list of components is kept anywhere.
      const syncUnits = tenantSyncUnits(requiredImages, await ports.attestedBuilds());
      const params: CreateTenantParams = {
        guid,
        // Frozen from the approved validation: the run executes what was approved.
        members: outcome.memberRecords, identityProvider: outcome.identityProvider,
        subdomain: req.subdomain,
        stage: rc.stage,
        clusterId: rc.clusterId,
        domain: rc.domain,
        cluster: rc.cluster,
        chartsRef: outcome.resolvedSha,
        registryHost,
        apps: req.apps,
        seedUsers: req.seedUsers,
        size: req.size,
        owner: req.owner,
        report: outcome.report,
        expectedApps,
        requiredImages,
        syncUnits,
        catalogRepoUrl: ports.catalogRepoUrl,
        replaces, // the existing same-subdomain tenants create-tenant prepends offboard steps for
        // Thread the operator's optional admin email into params so the `activate` step can invite the
        // first admin (spread conditionally — exactOptionalPropertyTypes forbids adminEmail: undefined).
        ...(req.adminEmail ? { adminEmail: req.adminEmail } : {}),
      };
      const stepDefs = createTenantSteps(ports, params);
      const plan: Plan = {
        kind: "create-tenant",
        targetKind: "cluster",
        targetId: rc.clusterId,
        // The replace sentence carries the SAME data warning tenant-offboard's summary gives, because
        // approving this plan approves the same prune: the replaced tenant's member databases go with
        // its ServiceClaim deletions, and only its identity survives for a purge to reap.
        summary: `Create tenant ${guid} (${req.subdomain}) on ${rc.domain} (${rc.stage}) pinned at ${outcome.resolvedSha.slice(0, 7)} with ${req.apps.length} app(s): ${stepDefs.length} steps.${replaces.length ? ` Replaces existing ${replaces.map((r) => r.guid).join(", ")} (subdomain "${req.subdomain}") before deploying ${guid}. The replaced tenant's member DATABASES are NOT kept: pruning its fan-out deletes every member's ServiceClaim, and the service-provisioner drops a claim's databases together with its user — run a backup first if the data has to come back. Its identity (the Vault crypto entry, the namespaces) survives until a purge reaps it.` : ""}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [], // no host owned — the Manager acts master-locally
        locks: tenantLocks(ports.registrations),
        warnings: [],
        // The tenant's object storage, handed over at approve and written into the SAME Vault entry
        // as the crypto. Every other value a tenant needs is minted or derived; these three are made
        // at Cloudflare, and the account-scoped token that makes them is not this tier's to hold.
        // Without them a tenant's engine REFUSES TO BOOT in production: the chart pins
        // UPLOAD_STORAGE=r2 and the engine's storage-factory will not fall back to local disk there.
        requiredSecrets: [`${STORAGE_SECRET_PREFIX}key`, `${STORAGE_SECRET_PREFIX}secret`],
        // The endpoint is not a secret — it is a public URL — so it travels in the clear beside them.
        requiredInputs: [{ field: STORAGE_ENDPOINT_FIELD, label: "R2 endpoint of the tenant's bucket (https://<account-id>[.<jurisdiction>].r2.cloudflarestorage.com)" }],
      };
      return { outcome: "planned", params, plan };
    },
    // The rollback, both halves, from create-tenant-abort.ts: WHAT the compensations are (the shared
    // teardown under its abort flavour), and WHETHER they may run — a full un-deploy must never fire for
    // a run whose tenant has meanwhile gone live, which only the tenants row + the GitOps pointer can say.
    steps: (params) => createTenantSteps(ports, params),
    cleanups: (params) => createTenantCleanups(ports, params),
    assertAbortable: (params, deps) => assertCreateTenantAbortable(ports, params, deps.db),
  };
}
