import { join } from "node:path";
import type { Config } from "../kernel/config.ts";
import type { Logger } from "../kernel/logger.ts";
import type { CredentialStore } from "../security/store.ts";
import type { Db } from "../db/client.ts";
import type { AnyRunDefinition } from "../executor/types.ts";
import { GitRepoReader, GitPlatformRepo, GitConsumerRepo } from "../adapters/git/git.ts";
import type { PlatformRepo } from "../adapters/git/port.ts";
import { KubeMasterArgoReader, KubeClusterReader, KubeMasterProjectWriter } from "../adapters/kube/kube.ts";
import { KubeBuildRbacWriter } from "../adapters/kube/kube-rbac.ts";
import { KubeRepoCredentialWriter } from "../adapters/kube/kube-repo-credential.ts";
import { CloudflareDns } from "../adapters/dns/cloudflare-dns.ts";
import type { DnsProvider } from "../adapters/dns/port.ts";
import { clusterValueChainPaths, type ClusterValueFile } from "../../shared/cluster-values.ts";
import { unitApexFromChain } from "../domains/units/admission-policy.ts";
import type { Stage } from "../../shared/enums.ts";
import { buildPlaneFqdnFromMarkings } from "../domains/inventory/cluster-marking.ts";
import { booksBranch } from "../domains/inventory/read.ts";
import { makeClusterKubeResolver } from "../domains/units/cluster-kube.ts";
import type { ClusterKubeResolver } from "../adapters/kube/port.ts";
import { TektonGateRunner } from "../adapters/gate-runner/gate-runner-tekton.ts";
import { HttpRegistryProbe } from "../adapters/registry/registry-http.ts";
import { TektonBuildPlane } from "../adapters/build-plane/build-plane-tekton.ts";
import { VaultSelfSeeder } from "../adapters/vault/vault-self-seeder.ts";
import type { VaultSeeder } from "../adapters/vault/seeder-port.ts";
import { HttpActivator } from "../adapters/activation/activation-http.ts";
import type { Activator } from "../adapters/activation/port.ts";
import { HttpGitHubConsumer } from "../adapters/github-consumer/github-consumer-http.ts";
import { HelmCliRenderer } from "../adapters/helm/helm.ts";
import { Registrations, clusterStageFromMarkings } from "../domains/units/registrations.ts";
import { TenantRegistrations, CATALOG_CHART_BRANCH } from "../domains/units/tenant-registrations.ts";
import type { ClusterStageResolver } from "../domains/units/registrations.ts";
import { makeOnboardDef, type OnboardPorts } from "../domains/units/onboard.run.ts";
import { makeOffboardDef } from "../domains/units/offboard.run.ts";
import { makePurgeDef } from "../domains/units/purge.run.ts";
import { makeAdoptConsumerDef } from "../domains/units/adopt-consumer.run.ts";
import { makeSuspendDef, makeResumeDef } from "../domains/units/suspend-resume.run.ts";
import { makeRestartWorkloadsDef, makeTenantRestartWorkloadsDef } from "../domains/units/restart-workloads.run.ts";
import { makeSetSizeDef, makeTenantSetSizeDef } from "../domains/units/set-size.run.ts";
import type { LifecyclePorts, TenantLifecyclePorts } from "../domains/units/lifecycle.ts";
import { makeCreateTenantDef, type TenantOnboardPorts } from "../domains/units/create-tenant.run.ts";
import { makeCheckTenantsDef } from "../domains/units/check-tenants.run.ts";
import { HttpTenantHealthReader } from "../adapters/tenant-health/tenant-health-http.ts";
import { makeAppCatalogProvider, type AppCatalogProvider } from "../domains/units/app-catalog.ts";
import { makeAddAppDef } from "../domains/units/add-app.run.ts";
import { makeSuspendTenantDef, makeResumeTenantDef, makeRemoveAppDef } from "../domains/units/tenant-lifecycle.run.ts";
import { makeOffboardTenantDef } from "../domains/units/tenant-offboard.run.ts";
import { makeTenantPurgeDef } from "../domains/units/tenant-purge.run.ts";
import { HttpPublicProbe } from "../adapters/http-probe/http-probe.ts";
import type { RelocationPorts } from "../domains/units/relocation.ts";
import type { ConsumerRelocationPorts } from "../domains/units/relocation-world-consumer.ts";
import type { TenantRelocationPorts } from "../domains/units/relocation-world-tenant.ts";
import { makeBackupDef, makeTenantBackupDef } from "../domains/units/backup.run.ts";
import { makeRestoreDef, makeTenantRestoreDef } from "../domains/units/restore.run.ts";
import { makeMigrateDef, makeTenantMigrateDef } from "../domains/units/migrate.run.ts";
import { errValidation } from "../kernel/errors.ts";

// The unit composition — the only place the real
// unit adapters are constructed and handed to the Run families. Kept out of wire.ts to keep that
// file focused. Two INDEPENDENT families live here:
//
//  - CONSUMER units: the Tekton gate-runner + platform/kube adapters. Goes live ONLY when BOTH
//    the gate-runner config (ONBOARD_GATE_MANAGER_ADDR) and the platform repo (github) are
//    configured — a partial config is a 501, never a half-wired feature.
//  - TENANT (multi-app) units: a SECOND GitPlatformRepo bound to catalog + the
//    manager-side HelmRenderer (tenant charts are trusted first-party, validated manager-side —
//    NO gate-runner). Goes live when the catalog write PAT is configured. It is NOT gated on
//    the consumer prerequisites: a cluster can run tenants without a consumer gate-runner.
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
const RELEASE_WORKFLOW_TIMEOUT_MS = 5 * 60_000;
// The build-plane release run (clone + install + buildah + bump + sync) gets the cold-build ceiling —
// the same order the tenant ensure-images budget uses, for the same reason.
const RELEASE_BUILD_TIMEOUT_MS = 30 * 60_000;
// A whole tenant fan-out (base + trio + N per-app stacks) has more to converge than a single consumer
// app, so it gets a longer budget before the set-watch fails loudly.
const TENANT_WATCH_TIMEOUT_MS = 15 * 60_000;
// Where the Deployment mounts the manager-registry-pull dockerconfigjson (hostyour-cloud
// apps/manager/templates/deployment.yaml, volume `registry-pull`) — the SAME pull credential the
// pod's imagePullSecrets reference; the RegistryProbe parses its basic auth for the /v2 manifest
// probes. A platform constant of the chart, like the gate-runner namespace/SA names below.
const REGISTRY_PULL_DOCKERCONFIG_PATH = "/etc/manager/registry-pull/.dockerconfigjson";

export interface UnitsWiring {
  defs: AnyRunDefinition[];
  /** Consumer onboarding routes go live (gate-runner + platform repo both configured). */
  enabled: boolean;
  /** Tenant onboarding routes go live (the catalog write PAT is configured). */
  tenantEnabled: boolean;
  /** The consumer family's per-cluster kube resolver, threaded to registerConsumerRoutes so the
   *  per-consumer live reconciliation read (GET /api/consumers/:id/live) can reach the target
   *  cluster + ArgoCD. Undefined when consumer onboarding is not configured — the live endpoint
   *  then degrades to SQL-only. */
  resolver?: ClusterKubeResolver;
  /** The TENANT family's per-cluster kube resolver, threaded to registerTenantRoutes so the per-tenant
   *  live reconciliation read (GET /api/tenants/:id/live) can reach the target cluster + ArgoCD.
   *  Undefined when tenant onboarding is not configured — the live endpoint then degrades to SQL-only. */
  tenantResolver?: ClusterKubeResolver;
  /** The ONE repo every tenant's charts live in, threaded to registerTenantRoutes beside
   *  tenantResolver: the live read asks the base Application which of its spec sources targets
   *  catalog, the way the consumer read asks with the app row's own repoUrl. Undefined exactly
   *  when tenantResolver is — both come from config.catalog. */
  catalogRepoUrl?: string;
  /** The tenant app-type catalog provider, threaded to registerTenantRoutes so GET
   *  /api/tenants/app-catalog can offer the wizard the values-<app>.yaml overlays in catalog.
   *  Undefined when tenant onboarding is not configured — the catalog route then serves { apps: [] }. */
  appCatalog?: AppCatalogProvider;
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
  /** The CONSUMER family's registration registrations, threaded to registerConsumerRoutes so the
   *  operator-triggered DETECTED scan (GET /api/consumers/detected) can diff the
   *  LIVE registrations/** against the inventory — the consumer twin of tenantRegistrations above, and the
   *  SAME Registrations the consumer runs commit through. Undefined when consumer onboarding is not
   *  configured; the scan route then degrades to an empty result with a reason. */
  registrations?: Registrations;
  /** A cluster's public unit apex (global.unitApex off its values chain), threaded to
   *  registerTenantRoutes so POST /api/tenants/:id/invite-admin addresses the tenant's example-auth at
   *  `auth.<subdomain>.<unitApex>` — the host the member's chart renders. The SAME resolver the tenant
   *  runs carry, so the route and the create-tenant `activate` step compose one host, not two.
   *  Undefined without the platform repo, which is also when the tenant family stays off. */
  resolveUnitApex?: (domain: string, stage: Stage) => Promise<string>;
  /** The writer of the PLATFORM repo (hostyour-cloud), handed to buildRunDefinitions so deploy-slave can mark
   *  a slave reachable in clusters/active/<fqdn>.yaml on the books branch. Gated on config.github and
   *  a derivable books branch, and on nothing else — the gate-runner config the consumer family
   *  additionally needs has nothing to do with writing a map, and a control host without a gate-runner
   *  still deploys slaves. */
  platformRepo?: PlatformRepo;
}

interface Family {
  defs: AnyRunDefinition[];
  enabled: boolean;
  /** Present only for the consumer family — the resolver its live reconciliation endpoint reads
   *  the cluster + ArgoCD through. Undefined when the family is not configured. */
  resolver?: ClusterKubeResolver;
  /** Present only for the tenant family — the app-type catalog its wizard read route serves.
   *  Undefined when the family is not configured. */
  appCatalog?: AppCatalogProvider;
  /** Present only for the tenant family — the catalog URL its live read resolves the fan-out's
   *  pin against. Undefined when the family is not configured. */
  catalogRepoUrl?: string;
  /** Present only for the tenant family — the pointer registrations its orphan-scan read route diffs
   *  against the inventory. Undefined when the family is not configured. */
  tenantRegistrations?: TenantRegistrations;
  /** Present only for the consumer family — the registration registrations its detected-scan read route
   *  diffs against the inventory. Undefined when the family is not configured. */
  registrations?: Registrations;
}

/** The master (self-cluster) kube access every master-local client is built from: the pod
 *  ServiceAccount's in-cluster credentials by default, or the KUBECONFIG_PATH file when that
 *  explicit dev/test override is set (kube.ts buildKubeConfig dispatches on the variant). */
function masterKubeInput(config: Config): { kubeconfigPath: string } | { inCluster: true } {
  return config.kubeconfigPath !== undefined ? { kubeconfigPath: config.kubeconfigPath } : { inCluster: true };
}

export function buildUnits(config: Config, store: CredentialStore, db: Db, logger: Logger): UnitsWiring {
  // ONE activation client for the whole manager — a plain fetch to a consumer's / tenant's OWN public
  // ingress (no config gate; the target host is the unit's own). Constructed here and shared by BOTH
  // families' invite steps (consumer onboard-activate + tenant create-tenant-activate) so there is a
  // single instance, not one per family.
  const activator = new HttpActivator();
  // THE branch this installation keeps its books on (shared/branches.ts), resolved ONCE, here, where
  // the ports are built — not looked up per run. The Manager runs ON the cluster holding the master
  // role and that cluster's FQDN IS the branch, so the value is already in its own inventory
  // (clusters.domain, which the schema states is the install branch) with MASTER_FQDN behind it: this
  // function runs BEFORE seedMaster writes that row, so on a first boot the configured value is the
  // only statement there is. Every registration writer, every cluster-map read and the tenant
  // registrations in catalog stand on it, and it is handed down bound to the repo port rather
  // than threaded through the runs.
  const books = booksBranch(db, config.master?.fqdn);
  // The ONE writer of the platform repo: the consumer pointer registrations commits through it, and
  // deploy-slave writes the slave part of a cluster map through it. Built here so both get the same
  // instance (one worktree, one lock) and so it survives a control host with no gate-runner.
  // Without a books branch it is not built at all: every write through it would have to name a
  // branch, and the only name left would be the trunk — where a registration belongs to no
  // installation and to every future one at once.
  const platformRepo = config.github && books
    ? new GitPlatformRepo({
      platformRepoURL: `https://github.com/${config.github.owner}/${config.github.repo}.git`,
      booksBranch: books,
      // the deploy-branch program cuts and stamps this branch; a missing one is a fault to raise,
      // never a branch to mint from the trunk (adapters/git/git.ts, createsBooksBranch).
      createsBooksBranch: false,
      workRoot: join(config.dataDir, "onboard-git"),
      credentialId: "platform-write-pat",
      openCredential: () => Promise.resolve(Buffer.from(config.github!.token, "utf8")),
    })
    : undefined;
  // The stage boundary is enforced at BOTH registration writers, and both read the SAME cluster
  // markings (clusters/active/<fqdn>.yaml on the platform repo). The tenant registrations's own repo is
  // catalog, so it takes this resolver rather than a second PlatformRepo it could then write to.
  const clusterStage = platformRepo ? clusterStageFromMarkings(platformRepo) : undefined;
  // The unit DNS provider — ONE Cloudflare client for both families' provision-dns and
  // remove-dns steps. Absent (no token) ⇒ those steps fail loud (DNS is a mandatory part of the
  // run kinds), never a silent skip.
  const dns = config.dns ? new CloudflareDns({ apiToken: config.dns.cloudflareApiToken }) : undefined;
  // A cluster's own values chain on its install branch. The tenant runs carry no consumer Registrations,
  // so this reader serves them off the SAME platform-repo worktree: folded to the public unit apex
  // (global.unitApex) here, and handed over whole for the tenant planners, which derive the registrations
  // host from it and render every member chart with it.
  const readClusterValueChain = platformRepo
    ? async (domain: string, stage: Stage): Promise<ClusterValueFile[]> => {
      return platformRepo.withBranch(domain, async (cluster) => {
        const files: ClusterValueFile[] = [];
        for (const path of clusterValueChainPaths(stage)) {
          const content = await cluster.readFile(path);
          if (content !== null) files.push({ path, content });
        }
        return files;
      });
    }
    : undefined;
  const resolveUnitApex = readClusterValueChain
    ? async (domain: string, stage: Stage): Promise<string> => unitApexFromChain(await readClusterValueChain(domain, stage))
    : undefined;
  // The chain itself rides into the tenant family whole: the planners derive the registry host
  // from it (registryHostFromChain) AND render every member chart with it.
  const resolveClusterValueFiles = readClusterValueChain;
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
  const tenant = buildTenantOnboarding(config, store, db, activator, logger, platformRepo, clusterStage, dns, resolveUnitApex, resolveClusterValueFiles, relocation, seeder);
  const consumer = buildConsumerOnboarding(config, store, db, activator, logger, platformRepo, clusterStage, dns, relocation, tenant.tenantRegistrations, seeder);
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
    ...(consumer.registrations ? { registrations: consumer.registrations } : {}),
    ...(tenant.resolver ? { tenantResolver: tenant.resolver } : {}),
    ...(tenant.catalogRepoUrl ? { catalogRepoUrl: tenant.catalogRepoUrl } : {}),
    ...(tenant.appCatalog ? { appCatalog: tenant.appCatalog } : {}),
    ...(tenant.tenantRegistrations ? { tenantRegistrations: tenant.tenantRegistrations } : {}),
    // The shared activation client is always constructed above — surface it for the tenant invite route.
    activator,
    ...(resolveUnitApex ? { resolveUnitApex } : {}),
    ...(platformRepo ? { platformRepo } : {}),
  };
}

// ---- Consumer onboarding: the Tekton gate-runner + platform/kube adapters ----
function buildConsumerOnboarding(
  config: Config,
  store: CredentialStore,
  db: Db,
  activator: Activator,
  logger: Logger,
  platformRepo: PlatformRepo | undefined,
  clusterStage: ClusterStageResolver | undefined,
  dns: DnsProvider | undefined,
  relocation: Pick<RelocationPorts, "probe" | "jobTimeoutMs" | "storageBox" | "dbtoolsImage">,
  tenantRegistrations: TenantRegistrations | undefined,
  /** The SAME seeder the tenant family writes through — built once in buildUnits, because there is
   *  one Vault and one Manager identity. */
  seeder: VaultSeeder,
): Family {
  if (!config.onboarding || !config.github || !platformRepo || !clusterStage) return { defs: [], enabled: false };

  // Opens a SEALED credential (a private-repo read credential, a slave's cluster bearer) by id.
  const openCredential = (id: string): Promise<Buffer> => store.open(id, { purpose: "onboard" });

  const repo = new GitRepoReader({ openCredential });
  const registrations = new Registrations(platformRepo, clusterStage);
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
  const argo = new KubeMasterArgoReader(masterKubeInput(config));
  // The pod SA's in-cluster access covers the master's self-cluster (the owner's OWN apps). A
  // slave's namespace smoke needs that slave's cluster-admin bearer (plane creds) —
  // per-cluster ClusterReader resolution is the remaining multi-cluster wiring (multi-cluster integration).
  const cluster = new KubeClusterReader(masterKubeInput(config));
  // The Manager's one writing kube client: the per-consumer isolation AppProject on the master's
  // argocd namespace, over the pod SA's in-cluster access (the CR is master-local).
  const projects = new KubeMasterProjectWriter(masterKubeInput(config));
  // The per-cluster kube resolver: master reuses the trio above
  // verbatim (behavior-identical); a slave gets a per-slave ClusterReader over its harvested
  // bearer + sealed CA bundle, while argo/projects STAY master-local (the slave's Application CRs
  // + AppProject live in the per-slave ArgoCD instance ON the master). Injected alongside the single
  // clients; the resolver switches the steps to resolve per target cluster.
  const resolver = makeClusterKubeResolver({
    db,
    master: { clusterReader: cluster, argoReader: argo, projectWriter: projects },
    openCredential,
    buildClusterReader: (input) => new KubeClusterReader(input),
  });

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
  const consumerRepo = new GitConsumerRepo({ openCredential });

  // The unit's build grants (provision-build-rbac + its teardown inverses). Master-local like the
  // AppProject writer: the unit's `<name>-build` namespace and the ArgoCD namespace both live on the
  // cluster this pod runs on, so the pod SA's in-cluster access reaches both. ONE stateless instance
  // serves onboard, offboard and purge.
  const buildRbac = new KubeBuildRbacWriter(masterKubeInput(config));

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

  // The runs no longer carry the master trio directly — they resolve the RIGHT kube clients + ArgoCD
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
    // The platform's own GitOps repo — the per-consumer AppProject must allow the generated
    // Application's hostyour-cloud sources ($values ref + image-guard) next to the consumer's chart repo.
    platformRepoURL: `https://github.com/${config.github.owner}/${config.github.repo}.git`,
    // The gate-runner's own sandbox self-probe is the primary lock; a manager-side probe of the
    // must-fail targets before each job is a follow-up, so this attestation is asserted for now.
    attestListening: true,
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
    releaseWorkflowTimeoutMs: RELEASE_WORKFLOW_TIMEOUT_MS,
    releaseBuildTimeoutMs: RELEASE_BUILD_TIMEOUT_MS,
    buildPlane,
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
  };
  const lifecyclePorts: LifecyclePorts = { registrations, resolver, argoWatchTimeoutMs: ARGO_WATCH_TIMEOUT_MS };
  const consumerRelocationPorts: ConsumerRelocationPorts = {
    ...lifecyclePorts,
    ...relocation,
    registrations,
    platformRepoURL: onboardPorts.platformRepoURL,
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
    // backup / restore / migrate — ONE relocation mechanism over the Storage Box. The
    // provisioning writers ride along because a move re-arms the unit's isolation on the target,
    // and the DNS provider because a move is a content update of the unit's one record.
    makeBackupDef(consumerRelocationPorts),
    makeRestoreDef(consumerRelocationPorts),
    makeMigrateDef(consumerRelocationPorts),
  ].map((d) => d as unknown as AnyRunDefinition);

  // The resolver rides out so the consumer routes' live reconciliation read can resolve per-cluster
  // access at request time (the same resolver the runs already resolve through); the registrations rides
  // out so the detected scan (GET /api/consumers/detected) diffs the very pointers the runs commit.
  return { defs, enabled: true, resolver, registrations };
}

// ---- Tenant (multi-app) onboarding: catalog + the manager-side HelmRenderer ----
function buildTenantOnboarding(
  config: Config,
  store: CredentialStore,
  db: Db,
  activator: Activator,
  logger: Logger,
  platformRepo: PlatformRepo | undefined,
  clusterStage: ClusterStageResolver | undefined,
  dns: DnsProvider | undefined,
  resolveUnitApex: ((domain: string, stage: Stage) => Promise<string>) | undefined,
  resolveClusterValueFiles: ((domain: string, stage: Stage) => Promise<ClusterValueFile[]>) | undefined,
  relocation: Pick<RelocationPorts, "probe" | "jobTimeoutMs" | "storageBox" | "dbtoolsImage">,
  /** The SAME VaultSelfSeeder the consumer family writes through — one Vault, one identity. create-tenant
   *  seeds the tenant's crypto entry with it and tenant-purge destroys the same entry, so the writer and
   *  the destroyer are provably the same object. */
  seeder: VaultSeeder,
): Family {
  // A tenant registration names a cluster, and that name is checked against the cluster's marking at
  // the writer — so without a resolver for those markings the family stays off rather than writing a
  // registration nothing checked. The platform repo coordinates are required for the same kind of
  // reason: every member AppProject must allow the `$values` source its Application pulls from, and a
  // project written without it would fail every sync.
  if (!config.catalog || !platformRepo || !clusterStage || !resolveUnitApex || !resolveClusterValueFiles || !config.github) return { defs: [], enabled: false };

  const repoURL = config.catalog.repoURL;
  const platformRepoURL = `https://github.com/${config.github.owner}/${config.github.repo}.git`;
  // ONE first-party PAT (Contents: read+write on catalog) does BOTH jobs: the reader clones the
  // repo at a ref for manager-side validation, and the platform repo pushes tenant pointers. An
  // inline opener returns the configured token (never the store) — the SAME shape the consumer write
  // path uses for GITHUB_WRITE_PAT. It ignores the id, so any non-empty credentialId activates askpass.
  const deployToken = config.catalog.token;
  const openDeployToken = (): Promise<Buffer> => Promise.resolve(Buffer.from(deployToken, "utf8"));

  const repo = new GitRepoReader({ openCredential: openDeployToken });
  // The create-tenant wizard's app-type catalog: the SAME reader + read credential validateTenant clones
  // with, pointed at charts/example-engine/values-<app>.yaml on the default branch, cached with a short
  // TTL and fail-soft (a fetch error logs + serves []/stale, so the wizard never blank-screens).
  const appCatalog = makeAppCatalogProvider({
    repo,
    repoURL,
    ref: CATALOG_CHART_BRANCH,
    credentialId: "catalog-read-pat",
    warn: (fields, msg) => logger.warn(fields, msg),
  });
  const helm = new HelmCliRenderer(); // trusted first-party charts render manager-side (no sandbox)
  // A SECOND GitPlatformRepo, bound to catalog, with a DISTINCT workRoot: worktreeDir keys only
  // on the branch, and the two repos' books branches carry the SAME name — one installation, one
  // books branch, in both repositories — so sharing the consumer onboard-git root would put two
  // repositories in one worktree. The name is taken off the platform repo instead of resolved a
  // second time, so the two can never disagree. commitPush opts into a bounded exponential backoff
  // because many tenant lifecycle runs plus Tekton's own deploy-bump commits contend on this ONE
  // shared branch.
  const deployRepo = new GitPlatformRepo({
    platformRepoURL: repoURL,
    booksBranch: platformRepo.booksBranch,
    // catalog has no installer and no stamper, so this adapter is the only thing that can bring
    // the branch its tenant ApplicationSet generators read into being (adapters/git/git.ts).
    createsBooksBranch: true,
    workRoot: join(config.dataDir, "tenant-git"),
    credentialId: "catalog-write-pat",
    openCredential: openDeployToken,
    pushBackoff: { retries: 6, baseDelayMs: 250, maxDelayMs: 8_000 },
  });
  const tenantRegistrations = new TenantRegistrations(deployRepo, clusterStage);
  const argo = new KubeMasterArgoReader(masterKubeInput(config));
  const cluster = new KubeClusterReader(masterKubeInput(config));
  const projects = new KubeMasterProjectWriter(masterKubeInput(config));
  // The per-cluster kube resolver — tenants only ever land on slaves
  // (POLICY), so per-slave resolution is the path that matters here; the master trio still backs
  // the master-local argoReader/projectWriter. openCredential opens the sealed per-slave bearer from
  // the credential store (the SAME shape the consumer path uses). The steps reach it through the resolver.
  const resolver = makeClusterKubeResolver({
    db,
    master: { clusterReader: cluster, argoReader: argo, projectWriter: projects },
    openCredential: (id) => store.open(id, { purpose: "onboard" }),
    buildClusterReader: (input) => new KubeClusterReader(input),
  });

  // The ensure-images gate: the registrations probe reads the mounted manager-registry-pull
  // dockerconfigjson — the SAME pull credential the pod's imagePullSecrets reference — and answers
  // whether each pinned tag exists. Nothing here builds.
  const registryProbe = new HttpRegistryProbe({ dockerConfigPath: REGISTRY_PULL_DOCKERCONFIG_PATH });
  // The tenant's argo-sync grant: written master-locally like the member AppProjects, and armed for
  // the units that attest the builds the tenant pulls — read off the CONSUMER registration tree on the
  // platform repo (registrations/<unit>/build.yaml), which is where a claim on a build name stands.
  const buildRbac = new KubeBuildRbacWriter(masterKubeInput(config));
  const registrations = new Registrations(platformRepo, clusterStage);

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
    catalogCredentialId: "catalog-read-pat", // activates askpass on the validation clone
    argoWatchTimeoutMs: TENANT_WATCH_TIMEOUT_MS,
    registryProbe,
    buildRbac,
    attestedBuilds: () => registrations.listAttestedBuildNames(),
    // The mirror of G23's tenant-subdomain clause, read off the consumer registration tree: a
    // subdomain that is an onboarded unit's name would put this tenant's session cookies on the host
    // that consumer already serves (unit-dns.ts).
    consumerNames: () => registrations.listUnitNames(),
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
  };
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
    // tenant-purge destroys the crypto entry create-tenant seeded, through the same seeder.
    seeder,
  };

  // The tenant relocation ports: the lifecycle set (registrations/resolver/dns/argo-sync/apex) plus the
  // shared relocation surface and the platform repo URL the member AppProjects allow as a source.
  const tenantRelocationPorts: TenantRelocationPorts = {
    ...lifecyclePorts,
    ...relocation,
    platformRepoURL,
  };

  const defs: AnyRunDefinition[] = [
    makeCreateTenantDef(onboardPorts),
    // The periodic administrator check. It reads only — a Secret off each target cluster and one
    // GET per tenant — and writes what it found onto the inventory row. A CronJob starts it; the
    // schedule lives in Kubernetes so this process has none to keep across a restart.
    makeCheckTenantsDef({
      resolver: onboardPorts.resolver,
      resolveUnitApex: onboardPorts.resolveUnitApex,
      health: new HttpTenantHealthReader(),
    }),
    makeAddAppDef(onboardPorts),
    makeRemoveAppDef(lifecyclePorts),
    makeSuspendTenantDef(lifecyclePorts),
    makeResumeTenantDef(lifecyclePorts),
    // The tenant twin of the consumer restart run kind: same act, walked over the tenant's member
    // namespaces instead of a consumer's single one.
    makeTenantRestartWorkloadsDef(lifecyclePorts),
    makeTenantSetSizeDef(lifecyclePorts),
    makeOffboardTenantDef(lifecyclePorts),
    // tenant-purge / force-offboard removes a tenant's WHOLE footprint BY GUID even with no inventory
    // row (the orphaned partial create-tenant), and additionally destroys the crypto entry (the deprovision
    // cascade) + the namespace. Same narrow port set as the other lifecycle run kinds — the teardown and the
    // two cluster-side deletes all resolve through the per-cluster resolver.
    makeTenantPurgeDef(lifecyclePorts),
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
  return { defs, enabled: true, resolver, catalogRepoUrl: repoURL, appCatalog, tenantRegistrations };
}
