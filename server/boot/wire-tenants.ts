// The TENANT (multi-app) family of the unit composition, apart from wire-units.ts the way the
// consumer family stands there: a SECOND GitPlatformRepo bound to catalog + the manager-side
// HelmRenderer (tenant charts are trusted first-party, validated manager-side — NO gate-runner).
// Goes live when CATALOG_REPO and the platform repository are configured; it is NOT gated on the
// consumer prerequisites, but a tenant's own apps are built by the consumer's build chain at run time
// (wire-units.ts `lateBuild`). buildUnits calls it and merges what it returns with the consumer
// family's.
import { join } from "node:path";
import type { Config } from "../kernel/config.ts";
import type { Logger } from "../kernel/logger.ts";
import type { CredentialStore } from "../security/store.ts";
import type { AnyRunDefinition } from "../executor/types.ts";
import { GitRepoReader, GitPlatformRepo } from "../adapters/git/git.ts";
import type { PlatformRepo } from "../adapters/git/port.ts";
import { KubeBuildRbacWriter } from "../adapters/kube/kube-rbac.ts";
import type { DnsProvider } from "../adapters/dns/port.ts";
import type { ClusterValueFile } from "../../shared/cluster-values.ts";
import { STAGE, type Stage } from "../../shared/enums.ts";
import type { ClusterKubeResolver, MasterKubeClients } from "../adapters/kube/port.ts";
import { masterKubeInput } from "./master-kube.ts";
import { HttpRegistryProbe, REGISTRY_PULL_DOCKERCONFIG_PATH } from "../adapters/registry/registry-http.ts";
import type { VaultSeeder } from "#unit/server/adapters/vault/seeder-port.ts";
import type { ObjectStore } from "../adapters/object-store/port.ts";
import type { Activator } from "#unit/server/adapters/activation/port.ts";
import type { GitHubApp } from "../adapters/github-app/port.ts";
import { HelmCliRenderer } from "../adapters/helm/helm.ts";
import { Registrations } from "#unit/server/registrations.ts";
import { TenantRegistrations } from "../domains/units/tenant-registrations.ts";
import { makeTenantRestartWorkloadsDef } from "../domains/units/restart-workloads.run.ts";
import { makeTenantSetSizeDef } from "../domains/units/set-size.run.ts";
import { makeTenantSetRoutingDef } from "../domains/units/tenant-routing.run.ts";
import { makeTenantSetOwnDomainDef } from "../domains/units/tenant-own-domain.run.ts";
import type { TenantLifecyclePorts } from "../domains/units/lifecycle.ts";
import { makeCreateTenantDef, type TenantOnboardPorts } from "../domains/units/create-tenant.run.ts";
import type { RegisteredUnit, TenantBuildDeps } from "../domains/units/tenant-builds.ts";
import { makeCheckTenantsDef } from "../domains/units/check-tenants.run.ts";
import { tenantUnitProbes } from "../domains/units/tenant-unit-probes.ts";
import type { UnitProbes } from "#unit/server/check-units.ts";
import { HttpTenantHealthReader } from "../adapters/tenant-health/tenant-health-http.ts";
import { makeAppCatalogProvider, type AppCatalogProvider } from "../domains/units/app-catalog.ts";
import { makeAddAppDef } from "../domains/units/add-app.run.ts";
import { makeTenantRefreshMembersDef } from "../domains/units/tenant-refresh-members.run.ts";
import { makeTenantSetApprovedTagDef } from "../domains/units/tenant-approved-tag.run.ts";
import { makeTenantAppsRepoDef } from "../domains/units/tenant-apps-repo.run.ts";
import { makeSuspendTenantDef, makeResumeTenantDef, makeRemoveAppDef } from "../domains/units/tenant-lifecycle.run.ts";
import { makeOffboardTenantDef } from "../domains/units/tenant-offboard.run.ts";
import { makeTenantPurgeDef } from "../domains/units/tenant-purge.run.ts";
import { makeTenantAppsRepoPurgeDef, orphanBuildsScan } from "../domains/units/tenant-apps-repo-purge.run.ts";
import { readTenantSpec } from "../domains/units/tenant-apps-repo.run.ts";
import { unitNameFromRepoURL } from "../../shared/consumer.ts";
import type { OrphanBuildView } from "../../shared/api-types.ts";
import type { RelocationPorts } from "#unit/server/relocation.ts";
import type { TenantRelocationPorts } from "../domains/units/relocation-world-tenant.ts";
import { makeTenantBackupDef } from "../domains/units/backup.run.ts";
import { makeTenantRestoreDef } from "../domains/units/restore.run.ts";
import { makeTenantMigrateDef } from "../domains/units/migrate.run.ts";

// A whole tenant fan-out (base + trio + N per-app stacks) has more to converge than a single consumer
// app, so it gets a longer budget before the set-watch fails loudly.
const TENANT_WATCH_TIMEOUT_MS = 15 * 60_000;

// How long the routing move waits for the IdP to answer at its new address, and how often it asks:
// the product's charts reach the cluster through the catalog carry and an ArgoCD sync, which take
// minutes, so the budget is the carry's interval twice over.
const ROUTING_WAIT_MS = 30 * 60_000;
const ROUTING_POLL_MS = 15_000;

/** The credential id under which the tenant family's reader answers the catalog's configured read
 *  PAT — never a row of the store. Every other id the reader is handed is opened from the store. */
const CATALOG_READ_CREDENTIAL_ID = "catalog-read-pat";

/** What the tenant family hands the composition (wire-units.ts buildUnits): its defs, its flag and
 *  the collaborators its read routes need. */
export interface TenantFamily {
  defs: AnyRunDefinition[];
  enabled: boolean;
  /** The resolver its live reconciliation endpoint reads the cluster + ArgoCD through. Undefined
   *  when the family is not configured. */
  resolver?: ClusterKubeResolver;
  /** The app-type catalog its wizard read route serves. Undefined when the family is not configured. */
  appCatalog?: AppCatalogProvider;
  /** The reader of one tenant's own catalog. Undefined without the family or without a GitHub App. */
  /** The catalog URL its live read resolves the fan-out's pin against. Undefined when the family is
   *  not configured. */
  catalogRepoUrl?: string;
  /** The pointer registrations its orphan-scan read route diffs against the inventory. Undefined
   *  when the family is not configured. */
  tenantRegistrations?: TenantRegistrations;
  /** The build half of that scan (#241). Undefined when the family is not configured. */
  orphanBuilds?: () => Promise<OrphanBuildView[]>;
  /** Bring the catalog's books branch into being and to the catalog's trunk, so the tenant
   *  ApplicationSet's git generator has a revision to resolve before the first tenant exists and the
   *  member charts on that revision are the current ones. It crosses as a closure because buildUnits
   *  is synchronous and the boot that awaits it is not. Undefined when the family is not configured —
   *  there is then no catalog to write into. */
  carryTrunkToBooksBranch?: () => Promise<void>;
}

// ---- Tenant (multi-app) onboarding: catalog + the manager-side HelmRenderer ----
export function buildTenantOnboarding(
  config: Config,
  /** The credential store: the tenant family's reader opens a sealed credential from it — a
   *  tenant's own repository under the `github-app` credential its build registration names. */
  store: CredentialStore,
  activator: Activator,
  logger: Logger,
  platformRepo: PlatformRepo | undefined,
  dns: DnsProvider | undefined,
  resolveUnitApex: ((domain: string, stage: Stage) => Promise<string>) | undefined,
  resolveClusterValueFiles: ((domain: string, stage: Stage) => Promise<ClusterValueFile[]>) | undefined,
  relocation: Pick<RelocationPorts, "probe" | "jobTimeoutMs" | "storageBox" | "dbtoolsImage">,
  /** The SAME VaultSelfSeeder the consumer family writes through — one Vault, one identity. create-tenant
   *  seeds the tenant's crypto entry with it and tenant-purge destroys the same entry, so the writer and
   *  the destroyer are provably the same object. */
  seeder: VaultSeeder,
  /** Makes each tenant's bucket and mints the one key that reaches it. Absent (no managing token) ⇒
   *  create-tenant's seed step fails loud, for the same reason the seeder's absence does: a tenant
   *  short of one secret is a tenant whose pods never start. */
  objectStore: ObjectStore | undefined,
  /** The master-local clients and the one resolver over them, built in the composition root. */
  kube: { master: MasterKubeClients; resolver: ClusterKubeResolver },
  /** The consumer onboarding's ports, handed late: the tenant defs run its build-only chain per build
   *  unit a tenant lacks (tenant-builds.ts), and that family is wired after this one. */
  onboard: () => TenantBuildDeps | undefined,
  /** The unit check's slot (plugins/unit/server/check-units.ts): the tenant family registers its own
   *  probes into it, beside the ones the other family registered. */
  unitProbes: UnitProbes[],
  /** The platform's GitHub App — the identity the catalog is read and written with, and a tenant's
   *  own repository is created with. */
  githubApp: GitHubApp,
): TenantFamily {
  // The platform repo coordinates are required: every member AppProject must allow the `$values`
  // source its Application pulls from, and a project written without it would fail every sync.
  if (!config.catalog || !platformRepo || !resolveUnitApex || !resolveClusterValueFiles || !config.github) return { defs: [], enabled: false };

  const repoURL = config.catalog.repoURL;
  const platformRepoURL = `https://github.com/${config.github.owner}/${config.github.repo}.git`;
  // ONE identity does BOTH jobs: the reader clones the repo at a ref for manager-side validation, and
  // the platform repo pushes tenant pointers — the App's installation token, minted at every open,
  // because a token GitHub issues for an hour must never be held (#194). The readiness row
  // catalog.identity says whether the App reaches the catalog.
  const openDeployToken = async (): Promise<Buffer> => Buffer.from(await githubApp.installationToken(), "utf8");

  // The reader clones the catalog and the apps template under the catalog's own read credential,
  // and a tenant's OWN repository under the credential its build registration names: the one id
  // names the configured token, every other id is opened from the store — a `github-app` id by
  // minting the App's token at the open.
  const repo = new GitRepoReader({ openCredential: (id) => (id === CATALOG_READ_CREDENTIAL_ID ? openDeployToken() : store.open(id, { purpose: "tenant-apps-read" })) });
  // ONE INSTALLATION, ONE BOOKS BRANCH NAME, IN BOTH REPOSITORIES, so the name is taken off the
  // platform repo rather than resolved a second time here and the two can never disagree. In
  // catalog it is the revision every member chart is read at — by the Manager below and by every
  // member Application (hostyour-cloud clusters/argocd/files/tenants-appset.yaml), which is one
  // revision because ArgoCD's repo-server generates nothing for an Application naming one
  // repository twice at two commits.
  const books = platformRepo.booksBranch;
  const helm = new HelmCliRenderer(); // trusted first-party charts render manager-side (no sandbox)
  // A SECOND GitPlatformRepo, bound to catalog, with a DISTINCT workRoot: worktreeDir keys only
  // on the branch, and the two repos' books branches carry the SAME name, so sharing the consumer
  // onboard-git root would put two repositories in one worktree. commitPush opts into a bounded
  // exponential backoff because many tenant lifecycle runs plus Tekton's own deploy-bump commits
  // contend on this ONE shared branch.
  const deployRepo = new GitPlatformRepo({
    platformRepoURL: repoURL,
    booksBranch: books,
    // catalog has no installer and no stamper, so this adapter is the only thing that can bring
    // the branch its tenant ApplicationSet generators read into being, and the only thing that can
    // bring the catalog's trunk into it afterwards (adapters/git/git.ts).
    carriesTrunkToBooksBranch: true,
    workRoot: join(config.dataDir, "tenant-git"),
    credentialId: "catalog-write-pat",
    openCredential: openDeployToken,
    pushBackoff: { retries: 6, baseDelayMs: 250, maxDelayMs: 8_000 },
  });
  // Bring the books branch into being, and to the catalog's trunk, at BOOT. Two reasons, and the
  // act is one call (adapters/git/git.ts carryTrunkToBooksBranch).
  //
  // INTO BEING, rather than at the first tenant registration: the tenant ApplicationSet's git
  // generator reads that branch from the moment the installation is deployed, and a generator whose
  // revision resolves to nothing puts the ApplicationSet — and the root Application above it — in
  // error. Measured on a fresh install: `tenants-dev` was the one ApplicationSet in error on a
  // platform where every other Application was Synced and Healthy, and nothing anywhere said the red
  // was expected until somebody onboarded a tenant. A health view that is red about a correct
  // installation teaches the reader to ignore the colour.
  //
  // TO THE TRUNK, because every member Application reads its CHART off this branch and not off the
  // catalog's trunk — one repository at one revision, or ArgoCD's repo-server generates no manifest
  // at all. Nothing else in any repository merges the trunk into it, so without this call an
  // installation would run the member charts of the day its books branch was born, forever. THIS IS
  // THE ONLY MOMENT AN INSTALLATION MOVES ONTO NEWER MEMBER CHARTS: a change on the catalog's trunk
  // reaches a tenant at the Manager's next boot and at no other time.
  const carryTrunkToBooksBranch = (): Promise<void> => deployRepo.carryTrunkToBooksBranch();
  const tenantRegistrations = new TenantRegistrations(deployRepo);
  // Tenants only ever land on slaves (POLICY), so per-slave resolution is the path that matters
  // here; the master trio still backs the master-local argoReader/projectWriter. Both come from the
  // composition root — one resolver serves this family, the consumer family and the cluster run kinds.
  const { resolver } = kube;

  // The ensure-images gate: the registrations probe reads the mounted manager-registry-pull
  // dockerconfigjson — the SAME pull credential the pod's imagePullSecrets reference — and answers
  // whether each pinned tag exists. Nothing here builds.
  const registryProbe = new HttpRegistryProbe({ dockerConfigPath: REGISTRY_PULL_DOCKERCONFIG_PATH });
  // The tenant's argo-sync grant: written master-locally like the member AppProjects, and armed for
  // the units that attest the builds the tenant pulls — read off the CONSUMER registration tree on the
  // platform repo (registrations/<unit>/build.yaml), which is where a claim on a build name stands.
  const buildRbac = new KubeBuildRbacWriter(masterKubeInput(config));
  const registrations = new Registrations(platformRepo);

  // A unit the installation registered: build-only under registrations/<unit>/build.yaml, deployable
  // under a stage file. Its identity is not on the entry: it is the owner's, resolved from the URL
  // at every use (#226).
  const buildUnitRegistration = async (unit: string): Promise<RegisteredUnit | null> => {
    if (await registrations.readBuildRegistration(unit)) return { form: "build-only" };
    for (const stage of STAGE) {
      if (await registrations.readRegistration(stage, unit)) return { form: "deployable" };
    }
    return null;
  };
  // create-tenant + add-app drive the full port set (git reader + helm + the second platform repo);
  // the kube clients are resolved per target cluster at run time via the resolver.
  const onboardPorts: TenantOnboardPorts = {
    repo,
    helm,
    registrations: tenantRegistrations,
    resolver,
    catalogRepoUrl: repoURL,
    // The platform GitOps repo — a member Application's `$values` chain comes from it, so the member's
    // AppProject must allow it next to catalog.
    platformRepoURL,
    catalogCredentialId: CATALOG_READ_CREDENTIAL_ID, // activates askpass on the validation clone
    carryTrunkToBooksBranch,
    argoWatchTimeoutMs: TENANT_WATCH_TIMEOUT_MS,
    registryProbe,
    buildRbac,
    attestedBuilds: () => registrations.listAttestedBuildNames(),
    // The mirror of G23's tenant-subdomain clause, read off the consumer registration tree: a
    // subdomain that is an onboarded unit's host label would put this tenant's session cookies on
    // the host that consumer already serves (unit-dns.ts). Over every stage, as G23 reads the
    // subdomains over every stage.
    consumerHostLabels: async () =>
      (await Promise.all(STAGE.map((stage) => registrations.listAttestedHostLabels(stage, { unit: "" })))).flat().map((l) => l.host),
    // The tenant first-admin invite (create-tenant-activate.ts) — the SAME activation client the consumer
    // family uses (one instance, from buildUnits). Used only when the operator supplies an admin email.
    activator,
    // The tenant's ONE wildcard record (provision-dns) + the apex it is composed under.
    ...(dns ? { dns } : {}),
    resolveUnitApex,
    // The target cluster's whole values chain — the registry host and the member renders both
    // come off it, so the planner reads it once.
    resolveClusterValueFiles,
    // Writes <stage>/tenants/<guid>, the ONE Vault entry every member namespace of the tenant reads.
    seeder,
    // Makes the bucket that entry's three storage properties address, and mints the key that reaches
    // it and no other bucket of this account.
    ...(objectStore ? { objectStore } : {}),
    onboard,
    buildUnitRegistration,
    // Creates a tenant's own repository in the owner the App is installed in. Absent ⇒ the run
    // kind that needs it refuses at the plan, naming the three config keys.
    githubApp,
  };
  // The create-tenant wizard's app catalog: the SAME reader + read credential validateTenant clones
  // the catalog with, on the books branch, and the apps template (tenant.appsRepo) read with that
  // same credential (app-catalog.ts), cached with a short TTL and fail-soft (a fetch error logs +
  // serves no apps or the stale set, so the wizard never blank-screens). The branch and not the
  // trunk, so the wizard offers what this installation can actually deploy: a chart that reached
  // the catalog's trunk after the last carry is not on the branch the member Application would read
  // it from.
  const appCatalog = makeAppCatalogProvider({
    repo,
    repoURL,
    ref: books,
    ...(onboardPorts.catalogCredentialId ? { credentialId: onboardPorts.catalogCredentialId } : {}),
    warn: (fields, msg) => logger.warn(fields, msg),
  });
  // remove-app + tenant-suspend/-resume/-offboard only flip/drop the pointer + watch the fan-out — no
  // clone/render, so they take the narrower lifecycle port set (registrations + resolver).
  const lifecyclePorts: TenantLifecyclePorts = {
    registrations: tenantRegistrations,
    resolver,
    catalogRepoUrl: repoURL,
    argoWatchTimeoutMs: TENANT_WATCH_TIMEOUT_MS,
    // Every removal deletes the argo-sync grant beside the member AppProjects — the same writer that
    // provisioned it, so what create-tenant wrote is what a teardown takes back.
    buildRbac,
    // The remove-dns halves of tenant-offboard and tenant-purge — the same provider +
    // apex resolver the create side uses, so the record removed is the record created.
    ...(dns ? { dns } : {}),
    resolveUnitApex,
    // tenant-purge destroys the crypto entry create-tenant seeded, through the same seeder, and
    // withdraws the bucket keys create-tenant minted, through the same store.
    seeder,
    ...(objectStore ? { objectStore } : {}),
    // A tenant's apps bundle goes with its last app (#217): its build registration removed from the
    // same registrations the onboarding wrote; the repository stands (#241).
    githubApp,
    buildRegistrations: registrations,
    // What accounts for a build-only registration beside a tenant's bundle: the catalog's own build
    // units, read off its books branch at every scan (#241).
    catalogBuildUnits: async (signal) => ((await readTenantSpec(onboardPorts, signal ? { signal } : {}))?.buildRepos ?? []).map((b) => unitNameFromRepoURL(b.repo)),
  };
  const orphanBuilds = orphanBuildsScan(lifecyclePorts);

  // The tenant relocation ports: the lifecycle set (registrations/resolver/dns/argo-sync/apex) plus the
  // shared relocation surface and the platform repo URL the member AppProjects allow as a source.
  const tenantRelocationPorts: TenantRelocationPorts = {
    ...lifecyclePorts,
    ...relocation,
    platformRepoURL,
  };

  unitProbes.push(tenantUnitProbes(onboardPorts));
  const defs: AnyRunDefinition[] = [
    makeCreateTenantDef(onboardPorts),
    // The periodic administrator check. It reads only — a Secret off each target cluster and one
    // GET per tenant — and writes what it found onto the inventory row. The in-process timer of
    // boot/check-tenants-schedule.ts starts it.
    makeCheckTenantsDef({
      resolver: onboardPorts.resolver,
      resolveUnitApex: onboardPorts.resolveUnitApex,
      health: new HttpTenantHealthReader(),
      // Every standing unit's probes, run again on the same schedule (#210): whatever each family
      // registered into the slot by the time the run starts.
      units: () => unitProbes,
    }),
    makeAddAppDef(onboardPorts),
    // The members of a standing tenant resolved again off the product's manifest: the same port set
    // add-app judges with, because it renders and gates the same fan-out.
    makeTenantRefreshMembersDef(onboardPorts),
    // A version approved per tenant and app: it reads the stage pins and the registry the same way.
    makeTenantSetApprovedTagDef(onboardPorts),
    // The tenant's own apps repository, created from the catalog's apps bundle through the GitHub App
    // and onboarded build-only through the consumer family's chain (the same late-handed ports the
    // build units ride) — the SAME port set, because it reads the catalog and the template the way
    // create-tenant does.
    makeTenantAppsRepoDef(onboardPorts),
    makeRemoveAppDef(lifecyclePorts),
    makeSuspendTenantDef(lifecyclePorts),
    makeResumeTenantDef(lifecyclePorts),
    // The tenant twin of the consumer restart run kind: same act, walked over the tenant's member
    // namespaces instead of a consumer's single one.
    makeTenantRestartWorkloadsDef(lifecyclePorts),
    makeTenantSetSizeDef(lifecyclePorts),
    // The routing move reads the IdP at its new address with the same public probe the moves between
    // clusters read with.
    makeTenantSetRoutingDef({ ...lifecyclePorts, probe: tenantRelocationPorts.probe, routingWaitMs: ROUTING_WAIT_MS, routingPollMs: ROUTING_POLL_MS }),
    makeTenantSetOwnDomainDef({ ...lifecyclePorts, probe: tenantRelocationPorts.probe, routingWaitMs: ROUTING_WAIT_MS, routingPollMs: ROUTING_POLL_MS }),
    makeOffboardTenantDef(lifecyclePorts),
    // tenant-purge / force-offboard removes a tenant's WHOLE footprint BY GUID even with no inventory
    // row (the orphaned partial create-tenant), and additionally destroys the crypto entry (the deprovision
    // cascade) + the namespace. Same narrow port set as the other lifecycle run kinds — the teardown and the
    // two cluster-side deletes all resolve through the per-cluster resolver.
    makeTenantPurgeDef(lifecyclePorts),
    makeTenantAppsRepoPurgeDef(lifecyclePorts),
    // tenant-backup / tenant-restore / tenant-migrate — the same ONE relocation mechanism over the
    // whole member bracket.
    makeTenantBackupDef(tenantRelocationPorts),
    makeTenantRestoreDef(tenantRelocationPorts),
    makeTenantMigrateDef(tenantRelocationPorts),
  ].map((d) => d as unknown as AnyRunDefinition);

  // appCatalog + resolver + the repo URL + the registrations ride out so registerTenantRoutes can serve GET
  // /api/tenants/app-catalog from the same catalog reader the runs validate through, resolve
  // per-cluster access AND the fan-out's pin for the per-tenant live reconciliation read
  // (GET /api/tenants/:id/live), and scan the LIVE tenant pointers for orphans (GET /api/tenants/orphans)
  // through the very registrations the runs commit pointers with — all the same instances (and the same one
  // repoURL the appsets are rendered from) the runs use, never a second one.
  return { defs, enabled: true, resolver, catalogRepoUrl: repoURL, appCatalog, tenantRegistrations, orphanBuilds, carryTrunkToBooksBranch };
}
