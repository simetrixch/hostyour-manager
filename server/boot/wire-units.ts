import type { Config } from "../kernel/config.ts";
import type { OrphanBuildView } from "../../shared/api-types.ts";
import type { Logger } from "../kernel/logger.ts";
import type { CredentialStore } from "../security/store.ts";
import type { AnyRunDefinition } from "../executor/types.ts";
import { GitRepoReader, GitRepoWriter } from "../adapters/git/git.ts";
import type { PlatformRepo, RepoReader } from "../adapters/git/port.ts";
import { KubeBuildRbacWriter } from "../adapters/kube/kube-rbac.ts";
import { KubeRepoCredentialWriter } from "../adapters/kube/kube-repo-credential.ts";
import { CloudflareDns } from "../adapters/dns/cloudflare-dns.ts";
import { CloudflareR2 } from "../adapters/object-store/cloudflare-r2.ts";
import type { DnsProvider } from "../adapters/dns/port.ts";
import type { ClusterValueFile } from "../../shared/cluster-values.ts";
import { readClusterValueChain } from "../domains/inventory/cluster-value-chain.ts";
import { unitApexFromChain } from "../domains/units/admission-policy.ts";
import { type Stage } from "../../shared/enums.ts";
import { buildPlaneFqdnFromMarkings } from "../domains/inventory/cluster-marking.ts";
import { readChannelStages } from "../domains/inventory/channel-stages.ts";
import type { ClusterKubeResolver, MasterKubeClients, RepoCredentialWriter } from "../adapters/kube/port.ts";
import { masterKubeInput } from "./master-kube.ts";
import { TektonGateRunner } from "../adapters/gate-runner/gate-runner-tekton.ts";
import { TektonBuildPlane } from "../adapters/build-plane/build-plane-tekton.ts";
import { VaultSelfSeeder } from "../adapters/vault/vault-self-seeder.ts";
import type { VaultSeeder } from "../adapters/vault/seeder-port.ts";
import { HttpActivator } from "../adapters/activation/activation-http.ts";
import type { Activator } from "../adapters/activation/port.ts";
import { HttpGitHubConsumer } from "../adapters/github-consumer/github-consumer-http.ts";
import type { GitHubConsumer } from "../adapters/github-consumer/port.ts";
import type { GitHubApp } from "../adapters/github-app/port.ts";
import { Registrations } from "../domains/units/registrations.ts";
import { TenantRegistrations } from "../domains/units/tenant-registrations.ts";
import { makeOnboardDef, type OnboardPorts } from "../domains/units/onboard.run.ts";
import { makeOffboardDef } from "../domains/units/offboard.run.ts";
import { makePurgeDef } from "../domains/units/purge.run.ts";
import { makeAdoptConsumerDef } from "../domains/units/adopt-consumer.run.ts";
import { makeSuspendDef, makeResumeDef } from "../domains/units/suspend-resume.run.ts";
import { makeRestartWorkloadsDef } from "../domains/units/restart-workloads.run.ts";
import { makeSetSizeDef } from "../domains/units/set-size.run.ts";
import { makeSetSecretsDef, type SetSecretsPorts } from "../domains/units/set-secrets.run.ts";
import type { LifecyclePorts } from "../domains/units/lifecycle.ts";
import type { TenantBuildDeps } from "../domains/units/tenant-builds.ts";
import type { AppCatalogProvider } from "../domains/units/app-catalog.ts";
import { HttpPublicProbe } from "../adapters/http-probe/http-probe.ts";
import type { RelocationPorts } from "../domains/units/relocation.ts";
import type { ConsumerRelocationPorts } from "../domains/units/relocation-world-consumer.ts";
import { makeBackupDef } from "../domains/units/backup.run.ts";
import { makeRestoreDef } from "../domains/units/restore.run.ts";
import { makeMigrateDef } from "../domains/units/migrate.run.ts";
import { errValidation } from "../kernel/errors.ts";
import { buildTenantOnboarding } from "./wire-tenants.ts";

// The unit composition — the only place the real
// unit adapters are constructed and handed to the Run families. Kept out of wire.ts to keep that
// file focused. Two families are built, and each reaches into the other:
//
//  - CONSUMER units, here: the Tekton gate-runner + platform/kube adapters. Goes live ONLY when
//    BOTH the gate-runner config (ONBOARD_GATE_MANAGER_ADDR) and the platform repo (github) are
//    configured — a partial config is a 501, never a half-wired feature. It takes the tenant
//    registrations, so the name checks see the tenants' names too.
//  - TENANT (multi-app) units, in wire-tenants.ts: a SECOND GitPlatformRepo bound to catalog + the
//    manager-side HelmRenderer (tenant charts are trusted first-party, validated manager-side —
//    NO gate-runner). Goes live when the catalog, the platform repo, the unit apex and the
//    cluster value files are there. A tenant's own apps are built by the consumer's build chain,
//    which reaches it at run time through `lateBuild` below.
//
// Kube access never gates either family: the clients reach the Manager's OWN cluster in-cluster
// over the pod ServiceAccount (RBAC provisioned GitOps-side); a set KUBECONFIG_PATH is only the
// explicit dev/test file override (masterKubeInput below).
//
// buildUnits returns both families' defs merged (buildRunDefinitions consumes them together) plus the
// per-family `enabled` flags the routes read.

const ARGO_WATCH_TIMEOUT_MS = 10 * 60_000; // how long a consumer app has to sync / prune
// The gate-run budget pair. The sandbox CLI enforces GATE_JOB_BUDGET_MS inside the gate pod
// (job-budget-ms param); the manager-side validation poll is bounded a margin ABOVE it, so on
// a healthy run the in-pod budget always fires first and the poll bound only catches a
// PipelineRun that never settles at all — Tekton controller down, CRDs unserved, pod unscheduled.
const GATE_JOB_BUDGET_MS = 8 * 60_000;
const GATE_POLL_BUDGET_MS = GATE_JOB_BUDGET_MS + 2 * 60_000;
// One relocation Job (a dump or restore of a whole store) gets the cold-build ceiling — the same
// order the release build uses, because both are "copy a lot of bytes" waits.
const RELOCATION_JOB_TIMEOUT_MS = 30 * 60_000;
// The release workflow only mints the tag and pushes the deploy ref (checkout + two git pushes), so
// its correlation + follow budget is minutes; watch-deployment's bump-commit read shares it.
const DEPLOY_REF_VISIBLE_MS = 5 * 60_000; // the bump's push becomes visible in seconds; five minutes is generous
// The build-plane release run (clone + install + buildah + bump + sync) gets the cold-build ceiling —
// the same order the tenant ensure-images budget uses, for the same reason.
const RELEASE_BUILD_APPEAR_MS = 5 * 60_000; // the webhook fires the PipelineRun in seconds; five minutes is generous
export interface UnitsWiring {
  defs: AnyRunDefinition[];
  /** The DNS provider, for the mail DNS run kind (the master's egress address is read off its own
   *  A record there) — the same instance the unit records are written with. Absent without one. */
  dns?: DnsProvider;
  /** Consumer onboarding routes go live (gate-runner + platform repo both configured). */
  enabled: boolean;
  /** Tenant onboarding routes go live (CATALOG_REPO and the platform repository are configured). */
  tenantEnabled: boolean;
  /** The consumer family's per-cluster kube resolver, threaded to registerConsumerRoutes so the
   *  per-consumer live reconciliation read (GET /api/consumers/:id/live) can reach the target
   *  cluster + ArgoCD. Undefined when consumer onboarding is not configured — the live endpoint
   *  then degrades to SQL-only. */
  resolver?: ClusterKubeResolver;
  /** The writer of the units' ArgoCD repository Secrets, for the sweep the App-token refresh timer
   *  runs over every live unit (repo-credential-keep.ts). Undefined when consumer onboarding is not
   *  configured. */
  repoCredential?: RepoCredentialWriter;
  /** The TENANT family's per-cluster kube resolver, threaded to registerTenantRoutes so the per-tenant
   *  live reconciliation read (GET /api/tenants/:id/live) can reach the target cluster + ArgoCD.
   *  Undefined when tenant onboarding is not configured — the live endpoint then degrades to SQL-only. */
  tenantResolver?: ClusterKubeResolver;
  /** The ONE repo every tenant's charts live in, threaded to registerTenantRoutes beside
   *  tenantResolver: the live read asks the base Application which of its spec sources targets
   *  catalog, the way the consumer read asks with the app row's own repoUrl. Undefined exactly
   *  when tenantResolver is — both come from config.catalog. */
  catalogRepoUrl?: string;
  /** The tenant app catalog provider, threaded to registerTenantRoutes so GET
   *  /api/tenants/app-catalog can offer the wizard the apps of the apps repository's apps.yaml.
   *  Undefined when tenant onboarding is not configured — the catalog route then serves { apps: [] }. */
  appCatalog?: AppCatalogProvider;
  /** ONE tenant's own catalog — its bundle's apps.yaml, read under the `github-app` credential its
   *  build registration names — threaded to the route GET /api/tenants/:id/app-catalog; the SAME
   *  closure the tenant-add-app plan judges against. Undefined without tenant onboarding or without
   *  the App; the route then answers { apps: [], reason }. */
  /** The shared activation client (ONE HttpActivator for the whole manager), threaded to
   *  registerTenantRoutes so the operator-driven POST /api/tenants/:id/invite-admin can call a
   *  tenant's own example-auth first-admin bootstrap. Always constructed here. */
  activator?: Activator;
  /** The TENANT family's catalog pointer registrations, threaded to registerTenantRoutes so the
   *  operator-triggered orphan scan (GET /api/tenants/orphans) can diff the LIVE pointers against the
   *  inventory. The SAME TenantRegistrations the tenant runs commit through — one reader of tenants/**.
   *  Undefined when tenant onboarding is not configured; the scan route then degrades to an empty
   *  result with a reason. */
  tenantRegistrations?: TenantRegistrations;
  /** The build half of the orphan scan (#241). Undefined when the tenant family is not configured. */
  orphanBuilds?: () => Promise<OrphanBuildView[]>;
  /** Bring the catalog's books branch into being, and to the catalog's trunk, at boot. The tenant
   *  ApplicationSet's git generator reads that branch from the moment the installation is deployed,
   *  and every member Application reads its chart there too, so without this the ApplicationSet has
   *  no revision to resolve on a fresh installation and the charts never move afterwards. Undefined
   *  when tenant onboarding is not configured; there is then no catalog to write into. */
  carryTrunkToBooksBranch?: () => Promise<void>;
  /** The CONSUMER family's registration registrations, threaded to registerConsumerRoutes so the
   *  operator-triggered DETECTED scan (GET /api/consumers/detected) can diff the
   *  LIVE registrations/** against the inventory — the consumer twin of tenantRegistrations above, and the
   *  SAME Registrations the consumer runs commit through. Undefined when consumer onboarding is not
   *  configured; the scan route then degrades to an empty result with a reason. */
  registrations?: Registrations;
  /** The ONE Vault seeder both families write through, threaded to the App-token refresh
   *  (wire.ts): the entry it rewrites is the one the consumer family's seed-repo-pat created. */
  seeder: VaultSeeder;
  /** The CONSUMER family's repository reader, threaded to registerConsumerRoutes so the wizard's
   *  prefill (POST /api/consumers/prefill) reads a consumer repository's version before any run
   *  exists — the SAME GitRepoReader the onboard run clones with. Undefined when consumer
   *  onboarding is not configured; the prefill route then answers 501. */
  repoReader?: RepoReader;
  /** The consumer-PAT GitHub client and the platform repository's GitHub identity, threaded to the
   *  onboard POST and the prefill so both read the version an onboarding releases off the release
   *  tags (domains/units/release-version.ts). Undefined when consumer onboarding is not configured. */
  github?: GitHubConsumer;
  platformGitHub?: { owner: string; repo: string };
  /** A cluster's public unit apex (global.unitApex off its values chain), threaded to
   *  registerTenantRoutes so POST /api/tenants/:id/invite-admin addresses the tenant's example-auth at
   *  `auth.<subdomain>.<unitApex>` — the host the member's chart renders. The SAME resolver the tenant
   *  runs carry, so the route and the create-tenant `activate` step compose one host, not two.
   *  Undefined without the platform repo, which is also when the tenant family stays off. */
  resolveUnitApex?: (domain: string, stage: Stage) => Promise<string>;
}

/** What the consumer family hands the composition: its defs, its flag and the collaborators its
 *  read routes need. The tenant family's twin is TenantFamily (wire-tenants.ts). */
interface Family {
  defs: AnyRunDefinition[];
  enabled: boolean;
  /** The resolver its live reconciliation endpoint reads the cluster + ArgoCD through. Undefined
   *  when the family is not configured. */
  resolver?: ClusterKubeResolver;
  /** The registration registrations its detected-scan read route diffs against the inventory.
   *  Undefined when the family is not configured. */
  registrations?: Registrations;
  /** The repository reader its prefill route clones with. Undefined when the family is not
   *  configured. */
  repoReader?: RepoReader;
  github?: GitHubConsumer;
  /** The consumer onboarding's ports, so the tenant family can run the build-only chain per build unit (tenant-builds.ts). */
  onboardPorts?: OnboardPorts;
  platformGitHub?: { owner: string; repo: string };
}

export function buildUnits(
  config: Config,
  store: CredentialStore,
  logger: Logger,
  /** The master-local clients and the ONE per-cluster resolver over them, built in the composition
   *  root (boot/wire.ts) rather than per family. A family constructing its own trio and its own
   *  resolver from the same input puts both behind that family's configuration guard, and a cluster
   *  run kind then has no way to reach one at all. */
  kube: { master: MasterKubeClients; resolver: ClusterKubeResolver },
  /** The platform's GitHub App identity, built in the composition root beside the kube trio and for
   *  the same reason: the boot self-check names its installation owner, and a family building
   *  its own would put that identity behind the family's configuration guard. */
  githubApp: GitHubApp,
  /** The ONE writer of the platform repo, built in the composition root (boot/platform-repo.ts) —
   *  absent without GitHub coordinates or a books branch, and then neither family is built. */
  platformRepo: PlatformRepo | undefined,
): UnitsWiring {
  // ONE activation client for the whole manager — a plain fetch to a consumer's / tenant's OWN public
  // ingress (no config gate; the target host is the unit's own). Constructed here and shared by BOTH
  // families' invite steps (consumer onboard-activate + tenant create-tenant-activate) so there is a
  // single instance, not one per family.
  const activator = new HttpActivator();
  // The unit DNS provider — ONE Cloudflare client for both families' provision-dns and
  // remove-dns steps. Absent (no token) ⇒ those steps fail loud (DNS is a mandatory part of the
  // run kinds), never a silent skip.
  const dns = config.dns ? new CloudflareDns({ apiToken: config.dns.cloudflareApiToken }) : undefined;
  // The tenant object store — ONE Cloudflare client for create-tenant's bucket and the key it mints
  // for it. Absent (no managing token, or no account for it to manage) ⇒ that step fails loud, never
  // a tenant whose engine refuses to boot for want of a bucket it can reach.
  const objectStore = config.objectStorage
    ? new CloudflareR2({
        apiToken: config.objectStorage.apiToken,
        accountId: config.objectStorage.accountId,
        jurisdiction: config.objectStorage.jurisdiction,
      })
    : undefined;
  // A cluster's own values chain on its install branch. The tenant runs carry no consumer Registrations,
  // so this reader serves them off the SAME platform-repo worktree: folded to the public unit apex
  // (global.unitApex) here, and handed over whole for the tenant planners, which derive the registrations
  // host from it and render every member chart with it.
  const readChain = platformRepo
    ? async (domain: string, stage: Stage): Promise<ClusterValueFile[]> => readClusterValueChain(platformRepo, domain, stage)
    : undefined;
  const resolveUnitApex = readChain
    ? async (domain: string, stage: Stage): Promise<string> => unitApexFromChain(await readChain(domain, stage))
    : undefined;
  // The chain itself rides into the tenant family whole: the planners derive the registry host
  // from it (registryHostFromChain) AND render every member chart with it.
  const resolveClusterValueFiles = readChain;
  // The relocation surface both families' backup/restore/migrate defs share: the public
  // probe verify-quiesced measures with, the per-Job budget, the storage box and the dbtools image
  // pin. Box + image are optional in the WIRING — the steps that need them fail loud when absent.
  const relocation: Pick<RelocationPorts, "probe" | "jobTimeoutMs" | "storageBox" | "dbtoolsImage"> = {
    probe: new HttpPublicProbe(),
    jobTimeoutMs: RELOCATION_JOB_TIMEOUT_MS,
    ...(config.storageBox ? { storageBox: config.storageBox } : {}),
    ...(config.dbtoolsImage ? { dbtoolsImage: config.dbtoolsImage } : {}),
  };
  // The TENANT family is built FIRST: the consumer family's gate G23 must hold a candidate unit name
  // against the subdomains the tenants stand on (one name space, one apex — unit-dns.ts), and the
  // pointer registrations that answers that lives here.
  // ONE seeder for BOTH families, because there is one Vault and one Manager identity: the
  // consumer onboard seeds a consumer's ceremony secrets through it and create-tenant seeds a
  // tenant's crypto entry, and each run kind's removal destroys what its own seed wrote. Built here
  // rather than inside one family so neither can end up with a second identity.
  // The seeder writes over the Manager's OWN kubernetes-auth login — the same VAULT_* surface the
  // credential store authenticates with (config.vault) — because there is one Vault, on the master,
  // and a slave's secrets live on it under the master's per-slave KV mount. Absent (dev/tests without
  // Vault) every write fails closed inside the seeder rather than inventing an identity.
  const seeder = new VaultSelfSeeder(
    config.vault
      ? { self: { addr: config.vault.addr, k8sAuthMount: config.vault.k8sAuthMount, k8sRole: config.vault.k8sRole, saTokenPath: config.vault.saTokenPath } }
      : {},
  );
  // THE TENANT FAMILY IS WIRED FIRST (the consumer family needs its registrations) AND YET RUNS THE
  // CONSUMER'S BUILD CHAIN per build unit it lacks (tenant-builds.ts) — so the consumer ports reach it
  // through a holder filled once both stand. The tenant defs read it at run time, never at wiring.
  const lateBuild: { deps?: TenantBuildDeps } = {};
  const tenant = buildTenantOnboarding(config, store, activator, logger, platformRepo, dns, resolveUnitApex, resolveClusterValueFiles, relocation, seeder, objectStore, kube, () => lateBuild.deps, githubApp);
  const consumer = buildConsumerOnboarding(config, store, activator, logger, platformRepo, dns, relocation, tenant.tenantRegistrations, seeder, kube, githubApp);
  if (consumer.onboardPorts) {
    lateBuild.deps = {
      ports: consumer.onboardPorts,
      ...(consumer.platformGitHub ? { platformGitHub: consumer.platformGitHub } : {}),
      ...(platformRepo ? { platformRepo } : {}),
      githubApp,
    };
  }
  // The sanctioned type-erasure (registrations.ts): each typed RunDefinition<P> is stored executor-facing
  // as AnyRunDefinition; the executor parses params via paramsSchema before plan()/steps(). Both
  // families share one flat defs[] — the run kinds are disjoint, so buildRunDefinitions keys them apart.
  // The consumer resolver rides up so the consumer routes' live reconciliation read can reach the
  // target cluster + ArgoCD (undefined when consumer onboarding is not configured).
  return {
    defs: [...consumer.defs, ...tenant.defs],
    enabled: consumer.enabled,
    tenantEnabled: tenant.enabled,
    ...(consumer.resolver ? { resolver: consumer.resolver } : {}),
    ...(consumer.onboardPorts?.repoCredential ? { repoCredential: consumer.onboardPorts.repoCredential } : {}),
    ...(consumer.registrations ? { registrations: consumer.registrations } : {}),
    seeder,
    ...(consumer.repoReader ? { repoReader: consumer.repoReader } : {}),
    ...(consumer.github ? { github: consumer.github } : {}),
    ...(consumer.platformGitHub ? { platformGitHub: consumer.platformGitHub } : {}),
    ...(tenant.resolver ? { tenantResolver: tenant.resolver } : {}),
    ...(tenant.catalogRepoUrl ? { catalogRepoUrl: tenant.catalogRepoUrl } : {}),
    ...(tenant.appCatalog ? { appCatalog: tenant.appCatalog } : {}),
    ...(tenant.tenantRegistrations ? { tenantRegistrations: tenant.tenantRegistrations } : {}),
    ...(tenant.orphanBuilds ? { orphanBuilds: tenant.orphanBuilds } : {}),
    ...(tenant.carryTrunkToBooksBranch ? { carryTrunkToBooksBranch: tenant.carryTrunkToBooksBranch } : {}),
    // The shared activation client is always constructed above — surface it for the tenant invite route.
    activator,
    ...(resolveUnitApex ? { resolveUnitApex } : {}),
    // The DNS provider rides up for the mail DNS run kind (the master's egress address is read off
    // its own A record there) — the same instance the unit records are written with.
    ...(dns ? { dns } : {}),
  };
}

// ---- Consumer onboarding: the Tekton gate-runner + platform/kube adapters ----
function buildConsumerOnboarding(
  config: Config,
  store: CredentialStore,
  activator: Activator,
  logger: Logger,
  platformRepo: PlatformRepo | undefined,
  dns: DnsProvider | undefined,
  relocation: Pick<RelocationPorts, "probe" | "jobTimeoutMs" | "storageBox" | "dbtoolsImage">,
  tenantRegistrations: TenantRegistrations | undefined,
  /** The SAME seeder the tenant family writes through — built once in buildUnits, because there is
   *  one Vault and one Manager identity. */
  seeder: VaultSeeder,
  /** The master-local clients and the one resolver over them, built in the composition root. */
  kube: { master: MasterKubeClients; resolver: ClusterKubeResolver },
  /** The platform's GitHub App, for the cleanups that reach a unit's repository (#226). */
  githubApp: GitHubApp,
): Family {
  if (!config.onboarding || !config.github || !platformRepo) return { defs: [], enabled: false };

  // Opens a SEALED credential (a private-repo read credential, a slave's cluster bearer) by id.
  const openCredential = (id: string): Promise<Buffer> => store.open(id, { purpose: "consumer-onboard" });

  const repo = new GitRepoReader({ openCredential });
  const registrations = new Registrations(platformRepo);
  // WHERE the build webhook points. The image-builder EventListener stands on ONE cluster, and every
  // cluster's map names it in `build-plane`, so onboard (create) and offboard/purge (delete) read the
  // host off the same map instead of composing it from the cluster a unit happens to deploy on.
  const resolveBuildPlaneFqdn = buildPlaneFqdnFromMarkings(platformRepo);
  // The gate-runner is an in-cluster Tekton PipelineRun (gate-runner-tekton.ts), dispatched into the
  // locked-down `gate-runner` namespace on the control cluster (over the Manager pod's own SA, or
  // the KUBECONFIG_PATH dev override). The pipeline/SA/namespace are platform constants (hostyour-cloud
  // apps/gate-runner); the fence targets + kubeconform version come from config; the workspace +
  // budget are the render's ceilings.
  const runner = new TektonGateRunner({
    ...(config.kubeconfigPath !== undefined ? { kubeconfigPath: config.kubeconfigPath } : {}),
    namespace: "gate-runner",
    pipelineName: "gate-run",
    serviceAccount: "pipeline-sa",
    reportWriterServiceAccount: "gate-report-writer",
    podFsGroup: 1000,
    workspaceStorage: "1Gi",
    runnerVersion: config.version,
    kubeVersion: config.onboarding.kubeVersion,
    jobBudgetMs: GATE_JOB_BUDGET_MS,
    fence: config.onboarding.fence,
    openCredential,
  });
  // A restart orphans any gate-run in flight: the jobId lived only in the dying process (the boot
  // resume fails the interrupted `planning` runs without it), so nothing else can ever name the
  // leftover objects — the settled PipelineRun, the report ConfigMap and above all the PAT-bearing
  // gate-cred Secret. Sweep them once now. Fire-and-forget: the sweep needs the kube API and boot
  // must not (LAW 0), so a failure only logs.
  void runner
    .reapOrphans()
    .then(({ reaped }) => {
      if (reaped > 0) logger.info({ reaped }, "gate-runner: reaped orphaned gate-run objects left by a previous process");
    })
    .catch((e: unknown) => logger.warn({ err: e }, "gate-runner: orphan sweep failed — leftover gate-run objects (including credential Secrets) may still stand"));
  // The master-local trio and the per-cluster resolver over it, both built in the composition root:
  // master reuses the trio verbatim, a slave gets a per-slave ClusterReader over its harvested bearer
  // + sealed CA bundle, while argo/projects STAY master-local (the slave's Application CRs +
  // AppProject live in the per-slave ArgoCD instance ON the master).
  const { argoReader: argo, clusterReader: buildClusterReader } = kube.master;
  const { resolver } = kube;

  // The per-call consumer-PAT GitHub client: the scope preflight, the build webhook
  // (create at onboard, remove at offboard/purge) AND the release workflow dispatch + watch. ONE
  // stateless instance serves every consumer. The HMAC secret is fed to the manager as env
  // (config.webhook.secret) because the seeder is write-only; absent ⇒ the onboard setup-webhook
  // step fails loud (no hook → no build).
  const github = new HttpGitHubConsumer();

  // The consumer-repo writer: commits the release-kit (release/ scripts + the
  // release workflow) into the CONSUMER's own repo at onboard, and offboard/purge git-rm it. It opens
  // the SAME sealed one-PAT-per-consumer the reader clones with (openCredential) via askpass; it
  // resolves the consumer repo's default branch itself. ONE stateless instance serves all three run kinds.
  const consumerRepo = new GitRepoWriter({ openCredential });

  // The unit's build grants (provision-build-rbac + its teardown inverses). Master-local like the
  // AppProject writer: the unit's `<name>-build` namespace and the ArgoCD namespace both live on the
  // cluster this pod runs on, so the pod SA's in-cluster access reaches both. ONE stateless instance
  // serves onboard, offboard and purge.
  const buildRbac = new KubeBuildRbacWriter(masterKubeInput(config));

  // The watch that stands in front of those grants (await-build-namespace): the per-unit build
  // Application is generated into the MASTER's own argocd namespace by an ApplicationSet that runs
  // there, whichever cluster the unit targets — and a build-only unit has no clusterId to resolve a
  // reader from in the first place. So it is handed over directly, exactly as buildRbac above is.
  const buildArgo = argo;

  // The per-unit ArgoCD repository Secret (provision-repo-credential + its teardown inverses) —
  // master-local for the same reason: every ArgoCD instance's namespace lives on this cluster.
  const repoCredential = new KubeRepoCredentialWriter(masterKubeInput(config));

  // The release watch (watch-release-build): the unit's release PipelineRun runs in its OWN
  // `<name>-build` namespace on the build plane — this cluster — reached over the pod SA through
  // the per-unit manager-read grant provision-build-rbac wrote. A pure watch; the run itself is
  // created by the EventListener, never here.
  const buildPlane = new TektonBuildPlane({
    ...(config.kubeconfigPath !== undefined ? { kubeconfigPath: config.kubeconfigPath } : {}),
  });

  // The runs do not carry the master trio directly — they resolve the RIGHT kube clients + ArgoCD
  // namespace per target cluster (slave vs the master) through the resolver at run time.
  const onboardPorts: OnboardPorts = {
    repo,
    runner,
    registrations,
    // G23's tenant-subdomain clause. The tenant family owns the catalog pointer registrations, so a
    // manager wired for consumers but not for tenants cannot answer the question — and answering
    // it with an empty set would pass the gate by omission, which is the one outcome that must not
    // happen for a name that hands over another party's sessions. Fail loud instead.
    tenantSubdomains: () => {
      if (!tenantRegistrations) {
        throw errValidation(
          "onboarding a consumer requires the tenant pointer registrations (config.catalog) to check the unit name against the tenants' subdomains — a consumer named after one serves the host that tenant's example-auth scopes its session cookies to",
        );
      }
      return tenantRegistrations.listTenantSubdomains();
    },
    seeder,
    resolver,
    // A CONSTANT, and the report says so rather than calling it a confirmation. Nothing here probes
    // the must-fail targets: this is the Manager's word that they were listening, and the leg is
    // named `…DeclaredListening` end to end so a receipt cannot be read as a measurement. What a
    // measurement would be worth is a separate question, because the vantage that matters is the
    // SANDBOX's and not this pod's — the Manager reaches addresses the gate pod cannot, so a probe
    // from here can attest a target the fence never had to block.
    declareListening: true,
    // The platform's OWN unit, by name, from the deployment. Present ⇒ that one unit may be
    // onboarded without a gate run, and only at the first installation in the master role
    // (domains/units/first-master.ts holds the other three conditions). Omitted when unset, so a
    // Manager that does not install first masters carries no such branch at all.
    ...(config.platformUnitName ? { platformUnitName: config.platformUnitName } : {}),
    // The channel ceiling, read off the platform repo's trunk per plan — the same read the wizard's
    // GET /api/consumers/channels serves, so the plan refuses exactly what the wizard did not offer.
    channelStages: () => readChannelStages(platformRepo),
    // The manager-side bound of the validation poll — a margin above the sandbox job budget
    // (see the GATE_* pair above).
    validationBudgetMs: GATE_POLL_BUDGET_MS,
    argoWatchTimeoutMs: ARGO_WATCH_TIMEOUT_MS,
    // The post-onboard activation client: a plain fetch to a consumer's PUBLIC ingress, used
    // only by the `activate` step of a consumer that declares an `activation:` block (e.g. example-auth's
    // first-admin bootstrap). No config gate — the target host is the consumer's own public host. Shared
    // with the tenant family (buildUnits constructs the one instance).
    activator,
    // The consumer-PAT GitHub client (preflight-scopes, setup-webhook, trigger-release and the
    // workflow watch). The HMAC secret is optional in config (dev) but REQUIRED by setup-webhook —
    // absent ⇒ fail loud (no hook → no build).
    github,
    ...(config.webhook.secret ? { webhookSecret: config.webhook.secret } : {}),
    webhookSubdomain: config.webhook.subdomain,
    resolveBuildPlaneFqdn,
    // The release-cycle watches: the workflow correlation/follow and the build-plane release run.
    deployRefVisibleMs: DEPLOY_REF_VISIBLE_MS,
    releaseBuildAppearMs: RELEASE_BUILD_APPEAR_MS,
    buildPlane,
    // The build plane's own cluster reader (refresh-repo-pat): every `<name>-build` namespace stands
    // on this cluster, so the master-local reader is handed over directly, exactly as buildArgo is.
    buildClusterReader,
    // The unit's ONE public DNS record (provision-dns / remove-dns). Absent ⇒ fail loud.
    ...(dns ? { dns } : {}),
    // The ArgoCD repository credential (provision-repo-credential): without it the generated
    // Application cannot fetch the private consumer repo.
    repoCredential,
    // The consumer-repo writer (inject-release-kit step): commit the release-kit into the consumer
    // repo at onboard. UNCONDITIONALLY needed — absent ⇒ inject-release-kit fails loud (setup-webhook precedent).
    consumerRepo,
    // The build grants (provision-build-rbac step): the unit's AppProject blacklists Role/RoleBinding,
    // so the Manager writes them. UNCONDITIONALLY needed — absent ⇒ the step fails loud.
    buildRbac,
    buildArgo,
  };
  const lifecyclePorts: LifecyclePorts = { registrations, resolver, argoWatchTimeoutMs: ARGO_WATCH_TIMEOUT_MS, githubApp };
  const consumerRelocationPorts: ConsumerRelocationPorts = {
    ...lifecyclePorts,
    ...relocation,
    registrations,
    buildRbac,
    repoCredential,
    ...(dns ? { dns } : {}),
  };

  const defs: AnyRunDefinition[] = [
    makeOnboardDef(onboardPorts),
    // offboard additionally removes the unit's build repo PAT, its build webhook, its release-kit,
    // its DNS record, and it deletes the build grants + the repository credential (self-contained
    // teardown) — it takes the same seeder + github + consumer-repo + writer set. It needs neither the
    // webhook subdomain nor the build-plane resolver: the hook removal matches the EventListener path,
    // never a composed address.
    makeOffboardDef({ ...lifecyclePorts, seeder, github, consumerRepo, buildRbac, repoCredential, ...(dns ? { dns } : {}) }),
    // purge / force-offboard removes ONE STAGE's footprint BY NAME even with no inventory row (the
    // orphaned-partial-onboard case). Same ports as offboard.
    makePurgeDef({ ...lifecyclePorts, seeder, github, consumerRepo, buildRbac, repoCredential, ...(dns ? { dns } : {}) }),
    // adopt-consumer reconstructs a DETECTED consumer's missing apps row FROM its GitOps pointer
    // — the recovery twin of purge, keyed on the same name+stage+cluster with
    // the same narrow lifecycle port set (registrations read + resolver for attest-target/attest-live).
    makeAdoptConsumerDef(lifecyclePorts),
    makeSuspendDef(lifecyclePorts),
    makeResumeDef(lifecyclePorts),
    // restart-workloads rolls the unit's pods so they read their Secrets again — the last step of a
    // a new secret value, which ESO alone cannot take because an env var is materialized at container
    // start. Narrowest port set on the platform: it resolves the target cluster and patches, it
    // commits nothing and needs no writer.
    makeRestartWorkloadsDef(lifecyclePorts),
    // set-size writes the size table's CURRENT figures into the unit's registration — the only path
    // by which a table edit reaches something already deployed.
    makeSetSizeDef(lifecyclePorts),
    // The one path that changes a declared secret of a standing consumer (#245): the onboarding's
    // seed is create-only, so nothing else can. It reads the consumer's manifest through the owner's
    // identity, which is why it takes the GitHub client and the credential store beside the seeder.
    makeSetSecretsDef({ ...lifecyclePorts, seeder, github, store } satisfies SetSecretsPorts),
    // backup / restore / migrate — ONE relocation mechanism over the Storage Box. The
    // provisioning writers ride along because a move re-arms the unit's isolation on the target,
    // and the DNS provider because a move is a content update of the unit's one record.
    makeBackupDef(consumerRelocationPorts),
    makeRestoreDef(consumerRelocationPorts),
    makeMigrateDef(consumerRelocationPorts),
  ].map((d) => d as unknown as AnyRunDefinition);

  // The resolver rides out so the consumer routes' live reconciliation read can resolve per-cluster
  // access at request time (the same resolver the runs already resolve through); the registrations rides
  // out so the detected scan (GET /api/consumers/detected) diffs the very pointers the runs commit;
  // the repository reader rides out so the wizard's prefill clones with the reader the run clones with.
  return { defs, enabled: true, resolver, registrations, repoReader: repo, github, onboardPorts, platformGitHub: { owner: config.github.owner, repo: config.github.repo } };
}
