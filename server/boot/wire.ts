import type { Hono } from "hono";
import { loadConfig, type Config } from "../kernel/config.ts";
import { runActor } from "../kernel/actor.ts";
import { createLogger, type Logger } from "../kernel/logger.ts";
import { openDb, type DbHandle } from "../db/client.ts";
import { runSelfChecks, runAsyncSelfChecks, assertBlockingChecksPass, readinessOf, type CheckResult } from "./selfchecks.ts";
import { bootPhases } from "./boot-phases.ts";
import { scheduleTenantCheck } from "./check-tenants-schedule.ts";
import { scheduleNightlyBackup } from "./nightly-backup-schedule.ts";
import { seedMaster, stopMasterReconcile } from "./seed-master.ts";
import { unitPlugin, unitPorts } from "#unit/server/plugin.ts";
import { CloudflareDns } from "../adapters/dns/cloudflare-dns.ts";
import { createApp } from "../http/app.ts";
import type { CredentialStore } from "../security/store.ts";
import { buildCore } from "./core.ts";
import { activatePlugins, inDependencyOrder } from "./plugin-set.ts";
import { compiledPlugins } from "../plugins.ts";
import { registerPluginRoutes } from "../http/plugins-route.ts";
import { RunEventBus } from "../executor/bus.ts";
import { Executor } from "../executor/executor.ts";
import { buildRunDefinitions, type RunDefinitions } from "../domains/runs/run-definitions.ts";
import { repointUnitRecords } from "../domains/units/cluster-rename-records.ts";
import { buildUnits } from "./wire-units.ts";
import { createSshSession } from "../adapters/ssh/ssh2-session.ts";
import { HttpReleaseDownloads } from "../adapters/downloads/downloads.ts";
import { HttpMetricsQuery } from "../adapters/metrics/metrics-http.ts";
import { SessionCodec } from "../domains/access/session.ts";
import { LoginTxCodec } from "../domains/access/login-tx.ts";
import { registerAuthRoutes } from "../domains/access/routes.ts";
import { createOidcAdapter } from "../adapters/oidc/openid-client.ts";
import { EmergencyStore, createEmergencyApp, serveAdminSocket } from "../domains/access/emergency.ts";
import { registerRunRoutes } from "../domains/runs/api.ts";
import { registerClustersRoutes, registerServerRoutes } from "../domains/inventory/api.ts";
import { NetTcpProbe } from "../adapters/net-probe/net-probe.ts";
import { registerMailRoutes } from "../domains/mail/api.ts";
import { readMailDns, readMailEgress, type MailDnsDeps } from "../domains/mail/mail-dns.ts";
import { registerDnsRoutes } from "#unit/server/dns/api.ts";
import { readDnsInventory, type DnsInventoryDeps } from "#unit/server/dns/dns-inventory.ts";
import { DohPublicDns } from "../adapters/dns/public-dns.ts";
import { createGitHubPlatform } from "../adapters/github-platform/github-platform-http.ts";
import { registerBranchRoutes } from "../domains/branches/api.ts";
import { registerReleaseRoutes } from "../domains/releases/api.ts";
import { searchPlatformApps } from "../domains/registry-cleanup/search.ts";
import { registerConsumerRoutes, registerTenantRoutes } from "../domains/units/api.ts";
import { registerSetSizeRoutes } from "../domains/units/api-set-size.ts";
import { registerBackupRoutes } from "../domains/units/api-backups.ts";
import { registerOnboardPrefillRoute } from "../domains/units/api-onboard-prefill.ts";
import { registerTenantAppsRepoRoute } from "../domains/units/api-tenant-apps-repo.ts";
import { registerConsumerSecretsRoute } from "../domains/units/api-consumer-secrets.ts";
import { registerConsumerReleaseRoute } from "../domains/units/api-consumer-release.ts";
import { registerTenantAppCatalogRoute } from "../domains/units/api-tenant-app-catalog.ts";
import { ensureAppIdentityRow } from "../security/app-identity.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { refreshAppTokens } from "#unit/server/app-token-refresh.ts";
import { ensureTenantAppKeys } from "../domains/units/tenant-app-keys.ts";
import { syncReleaseKits } from "#unit/server/inject-release-kit.ts";
import { KubeHeadlampKubeconfig } from "../adapters/kube/kube-headlamp.ts";
import { syncHeadlampContexts } from "../domains/inventory/headlamp-contexts.ts";
import { gateReleaseWorkflow } from "../domains/units/gates/release-workflow.ts";
import { reapRegistry } from "./registry-reap.ts";
import { tenantHeldPins } from "../domains/units/tenant-pins.ts";
import { booksBranch } from "../domains/inventory/read.ts";
import { resolveRepoCredentialId } from "#unit/server/repo-identity.ts";
import { readChannelStages } from "../domains/inventory/channel-stages.ts";
import { registerResetRoutes } from "../domains/reset/api.ts";
import { registerSpa, spaDistDir } from "../http/spa.ts";
import type { AppEnv } from "../http/app-env.ts";
import { readPullConfiguration, REGISTRY_PULL_DOCKERCONFIG_PATH } from "../adapters/registry/registry-http.ts";
import type { ReadyzView } from "../../shared/api-types.ts";
import { RUN_KIND, type Stage } from "../../shared/enums.ts";

export interface Wired {
  config: Config;
  logger: Logger;
  db: DbHandle;
  store: CredentialStore;
  bus: RunEventBus;
  runDefinitions: RunDefinitions;
  executor: Executor;
  app: Hono<AppEnv>;
  emergencyApp: Hono;
  serveEmergencySocket: () => void;
  checks: CheckResult[];
  /** The deploy trunk carried into this installation's books branch — a clone and a merge over
   *  the network, the one slow act of boot. boot.ts starts it AFTER the server listens: awaited
   *  before, it held /healthz silent for the length of the carry and the liveness probe killed
   *  every rollout once. Never rejects — a failure is logged and the branch stays one product
   *  state behind, never a wrong one. */
  carryDeployTrunk: () => Promise<void>;
  /** The build repo-pat of every unit whose credential is the platform's GitHub App, rewritten with
   *  a token minted now, and ESO asked to write the unit's three build Secrets again from it
   *  (plugins/unit/server/app-token-refresh.ts). boot.ts runs it once behind the listening server
   *  and then every 45 minutes. Never rejects — every failure is logged per unit. A no-op where the
   *  consumer family is not wired: there are then no build registrations. */
  refreshAppTokens: () => Promise<void>;
  /** The Password field key of every tenant app, and the revalidate secret of every tenant website,
   *  that has none, written create-only (server/domains/units/tenant-app-keys.ts ensureTenantAppKeys):
   *  the forward step for the apps that joined before these keys were minted. boot.ts runs it once
   *  behind the listening server. Never rejects. A no-op where the unit family and its seeder, or the
   *  tenant registrations, are not wired. */
  mintTenantAppKeys: () => Promise<void>;
  /** The database list of every app of every standing tenant, as its catalog entry declares it, written
   *  into the registration's apps[] entries where it differs (server/domains/units/tenant-app-databases.ts
   *  ensureTenantAppDatabases): the forward step for the tenants registered before the lists were
   *  carried. boot.ts runs it once behind the listening server, after the deploy carry. Never rejects.
   *  A no-op where tenant onboarding is not wired. */
  writeTenantAppDatabases: () => Promise<void>;
  /** The current release kit written into the repository of every registered unit and of every library
   *  the deploy repository names, where it differs (plugins/unit/server/inject-release-kit.ts
   *  syncReleaseKits): a release made there by hand runs the kit this Manager ships. boot.ts runs it
   *  once behind the listening server, after the deploy carry, so a library added to the deploy
   *  repository's trunk is on the books branch it is read from; the kit changes only with a release,
   *  and a release boots the Manager. Never rejects — every failure is logged per repository. */
  syncReleaseKits: () => Promise<void>;
  /** One prune of the central registry (server/boot/registry-reap.ts), on this server's database,
   *  credential store and GitHub App; its floor holds every carrier's pins, every plugin's, and every
   *  image a tenant holds. boot.ts schedules it daily at REGISTRY_REAPER_HOUR. Undefined where the
   *  reaper is not configured. Never rejects. */
  reapRegistry: (() => Promise<void>) | undefined;
  /** The shared Headlamp's slave contexts brought to the installation's active slaves
   *  (server/domains/inventory/headlamp-contexts.ts). boot.ts runs it once behind the listening
   *  server, so the slaves a Manager release finds standing are offered. Never rejects. */
  syncHeadlampContexts: () => Promise<void>;
  /** Watch the release runs for the tenants that follow releases, and move the ones a release while
   *  the Manager was down left behind (server/domains/units/tenant-follow.ts). boot.ts starts it once
   *  behind the listening server. Never rejects. */
  startTenantFollow: () => Promise<void>;
}

/** The carry as boot runs it: LOG AND CONTINUE on failure — a deploy repository that is unreachable at
 *  start-up must not take the Manager down, and what a failure leaves behind is a branch one
 *  product state behind, never a wrong one. It is logged at error because this is the only place
 *  that can say which branch and why — /readyz carries a verdict, not a reason. Absent where the
 *  Manager writes no books (no deploy repository configured): then there is nothing to carry. */
export function carryDeployTrunkLater(carry: (() => Promise<void>) | undefined, logger: Logger): () => Promise<void> {
  return async () => {
    if (!carry) return;
    try {
      await carry();
    } catch (err) {
      logger.error(
        { err: String(err) },
        "the deploy trunk could not be carried into this installation's books branch there — if the branch does not exist yet, the tenant ApplicationSet's git generator has no revision to resolve and it and the root Application above it stay in error; if it does, every tenant goes on rendering the member charts it already carried"
      );
    }
  };
}

/**
 * THE composition root — the only place services are constructed and wired.
 * No other module holds a module-level instance. OIDC + the cluster collectors join here as
 * their increments land. The actor is the signed-in operator of the current request (the
 * chokepoint middleware binds it via kernel/actor.ts); outside any request — boot resume,
 * background jobs — it falls back to the seeded "op_system" row.
 */
export async function wire(): Promise<Wired> {
  const config = loadConfig();
  const logger = createLogger(config);
  // One line per boot phase with its duration (boot-phases.ts): the phase that holds the port
  // shut on a slow boot has a name in the log.
  const phase = bootPhases(logger);
  // Every compiled plugin's tables are migrated, active or not: one switched off keeps its tables,
  // and switching it on again needs no migration.
  const db = openDb(config.dbFile, inDependencyOrder(compiledPlugins));
  phase("database");
  // The credential store, the GitHub App identity, the master's kube access and the platform repo,
  // built the way every process of the product builds them (boot/core.ts). The App's client is held
  // by more than the store: the tenant family reads and writes the deploy repository and creates a tenant's own
  // repository with it, and the readiness checks below name the owner it is installed with.
  const core = buildCore(config, logger, db.db);
  const { store, githubApp, platformRepo } = core;
  // THE APP'S ONE ROW (#226): every clone and hook call of a repository the App reaches opens it.
  await ensureAppIdentityRow(store, githubApp);
  phase("credential store");
  // The plugins PLUGINS names, each activated over the core after the plugins it requires. A name
  // this build does not carry, a plugin setting that does not parse and a run kind brought twice
  // stop the boot here, all named at once (boot/plugin-set.ts).
  const active = activatePlugins(compiledPlugins, config.plugins, core, process.env, new Set<string>(RUN_KIND));
  phase("plugins");
  // The unit plugin's ports, which both families take from the set: neither is built without it.
  const unitWiring = active.find((p) => p.name === unitPlugin.name)?.wiring;
  const unit = unitWiring ? unitPorts(unitWiring.provides) : undefined;
  const bus = new RunEventBus();
  // Consumer onboarding: construct the real adapters and register the Run family — but only when the
  // Tekton gate-runner config (ONBOARD_GATE_MANAGER_ADDR) + platform repo are both configured
  // (else defs=[] and the mutating consumer routes answer 501). See wire-units.ts.
  // The master-local kube clients and the one resolver over them come from the core, never from a
  // family: a cluster deployment must not depend on consumer onboarding being configured.
  const masterKube = core.kube.master;
  const resolver = core.kube.resolver;
  // The shared Headlamp's slave contexts, written by the runs that add and remove a slave and at boot.
  const headlamp = new KubeHeadlampKubeconfig(core.kube.input);
  // The DNS provider — ONE Cloudflare client for the core's own runs (the mail DNS, the records a
  // renamed slave's units carry) and both families' provision-dns and remove-dns steps. Absent (no
  // token) ⇒ those steps fail loud (DNS is a mandatory part of the run kinds), never a silent skip.
  const dns = config.dns ? new CloudflareDns({ apiToken: config.dns.cloudflareApiToken }) : undefined;
  const units = buildUnits(config, store, logger, { master: masterKube, resolver }, githubApp, platformRepo, dns, unit);
  // The mail DNS of the installation, measured at public resolvers: the Mail page's deps, and the
  // mail half of the DNS inventory below — one measurement, so the two pages can never disagree
  // about one record. The platform repo gives the two sender domains, and the registrations the
  // stage's mail sender: the unit whose SMTP entry is attested there, and the cluster it stands on.
  const mailDns: MailDnsDeps = {
    db: db.db,
    publicDns: new DohPublicDns(),
    ...(platformRepo ? { platformRepo } : {}),
    ...(units.registrations ? { smtpSenders: (stage: Stage) => units.registrations!.listSmtpSenders(stage) } : {}),
  };
  // EVERY RECORD THIS INSTALLATION IS RESPONSIBLE FOR at the DNS provider, derived from its own
  // registrations and read there (plugins/unit/server/dns/dns-inventory.ts). That domain imports no other
  // domain, so the registration scans, the tenant pointers and the per-stage apex arrive as the
  // narrow functions it reads them through, bound here where both families are already built. A
  // family that is not configured simply contributes no reader, and the inventory says which part
  // of itself it could not list rather than answering with a zone that looks empty.
  const registrations = units.registrations;
  const tenantRegistrations = units.tenantRegistrations;
  const dnsInventory: DnsInventoryDeps = {
    db: db.db,
    mail: () => readMailDns(mailDns),
    ...(dns ? { dns } : {}),
    ...(registrations
      ? { consumers: async (cluster: string, stage: Stage) => (await registrations.listConsumerRegistrations(cluster, stage)).registrations.map((r) => ({ name: r.name, host: r.entry.host, fqdn: r.entry.fqdn ?? "" })) }
      : {}),
    ...(tenantRegistrations ? { tenants: async (stage: Stage) => (await tenantRegistrations.listTenantPointers(stage)).pointers } : {}),
    ...(units.resolveUnitApex ? { unitApex: units.resolveUnitApex } : {}),
  };
  const runDefinitions = buildRunDefinitions({
    db: db.db,
    // WHAT THE CLUSTER RUN KINDS READ ARGOCD THROUGH. gitops-handoff, verify-slave and argocd-follow
    // reach the master's ArgoCD and its ExternalSecrets over the pod's own ServiceAccount, the same
    // way every unit run kind does — never over an SSH session raised with the machine's password.
    resolver,
    ...(platformRepo ? { platformRepo } : {}),
    // The SAME two settings the platform repo above is built from, as the machine's programs are
    // answered with it: `owner/name`. deploy-host's git_clone row cannot read this off the machine,
    // because the checkout it would be read from is what that row establishes.
    ...(config.github ? { platformOrigin: `${config.github.owner}/${config.github.repo}` } : {}),
    ...(config.ansiwiseServeCommand ? { ansiwiseServeCommand: config.ansiwiseServeCommand } : {}),
    ...(config.ansiwiseDownloadUrl ? { ansiwiseDownloadUrl: config.ansiwiseDownloadUrl } : {}),
    // WHERE a machine's programs checkout is cloned from when it carries none (DEPLOY_PROGRAMS_REPO). The
    // machine cannot read this off itself for the same reason it cannot read the platform origin
    // above: the checkout it would be read from is the one this clone establishes. Unconditional
    // and carrying no credential — the setting defaults to the product's own repository and that
    // repository is public, so there is no pair to be half-configured.
    programsOrigin: { repoURL: config.deployProgramsRepoUrl },
    ...(dns ? { dns } : {}),
    mailEgress: (stage: Stage, masterDomain: string) => readMailEgress(mailDns, stage, masterDomain),
    // What a slave's rename repoints: every unit record naming its old FQDN, read off the unit rows of
    // the cluster and composed under the apex its map states.
    ...(dns && units.resolveUnitApex
      ? { unitRecords: (ctx, input) => repointUnitRecords({ dns, unitApex: units.resolveUnitApex! }, ctx, input) }
      : {}),
    // What dns-remove and mail-dns-unpublish are allowed to delete: a record is taken back only
    // where the inventory names it as this installation's, never by the name an operator typed.
    readDnsInventory: () => readDnsInventory(dnsInventory),
    // The mounted manager-registry-pull document, narrowed to one address — what a machine that
    // keeps no books is given so it pulls through the installation's own registry rather than
    // silently from docker.io. Unconditional: the path is where this manager's own chart mounts it,
    // and a manager whose file is not there fails naming the file rather than the setting.
    pullConfiguration: (registryHost: string) => readPullConfiguration(REGISTRY_PULL_DOCKERCONFIG_PATH, registryHost),
    // WHERE the bootstrap reads the two ansiwise executables. Unconditional and not behind a setting:
    // the address they are read FROM is the installation's (ANSIWISE_DOWNLOAD_URL above), while
    // reading bytes off it is a capability of this process that nothing can turn off and nothing
    // should.
    releaseDownloads: new HttpReleaseDownloads(),
    // The query API the deploy-slave run's SOFT metrics check asks. Behind the setting and not
    // unconditional, because the ABSENCE of this port is what the check reports as "this manager was
    // given no metrics query address" — a manager built with a client pointing nowhere would report
    // the same skip as an unreachable address, and those are two different faults.
    ...(config.metricsQueryUrl ? { metricsQuery: new HttpMetricsQuery(config.metricsQueryUrl) } : {}),
    headlamp,
  }, [...units.defs, ...active.flatMap((p) => p.wiring.definitions)]);
  const executor = new Executor({
    db: db.db,
    creds: store,
    bus,
    logger,
    runDefinitions,
    sshFactory: createSshSession,
    actor: runActor,
  });
  phase("units, run definitions and executor");
  // Master self-registration (seed-master.ts): make a fresh DB carry the role=master row +
  // its self-SSH key so deploy-slave works with zero manual SQL. If the ESO secret is late, or the
  // credential store cannot be reached, a background reconcile inside seedMaster keeps converging
  // pin+seal without a pod restart (unref'd — if a later blocking check fails boot, the exiting
  // process is not held open).
  // Degrade-friendly by design;
  // a genuine DB fault still surfaces (boot fails loud rather than running half-seeded).
  // The tenant administrator check: a run started on a timer. It is here rather than in a
  // CronJob because it must write into THIS database, which is a ReadWriteOnce volume held by a
  // single replica — the same dependency seed-master.ts states for its own reconcile.
  scheduleTenantCheck(executor, logger);
  // The tenants that follow releases: their Versions runs are planned and approved by this executor.
  const tenantFollow = units.tenantFollow?.(executor, db.db);
  scheduleNightlyBackup(executor, db.db, logger);
  await seedMaster(db.db, store, config, logger);
  phase("master seed");
  // The deploy repository's books branch, brought into being and up to the deploy trunk by boot —
  // behind the listening server, see Wired.carryDeployTrunk — rather than at the first tenant
  // registration (wire-units.ts carryTrunkToBooksBranch); every tenant plan carries it again.
  const carryDeployTrunk = carryDeployTrunkLater(units.carryTrunkToBooksBranch, logger);
  // The deletion after each rewrite reaches the build namespaces over the master-local cluster
  // reader: they stand on this cluster whatever cluster a unit targets.
  const { consumerRepo } = units;
  const refreshAppTokensLater = registrations && unit
    ? async (): Promise<void> => {
        await refreshAppTokens({ store, registrations, seeder: unit.seeder, kube: masterKube.clusterReader, logger, deployRepo: config.deployRepo, githubApp, owners: (org) => readOwnerIdentity(db.db, org) });
      }
    : async (): Promise<void> => undefined;
  // Each active plugin's own boot work, once, after the core's seeds (server/plugin.ts onBoot).
  for (const p of active) await p.wiring.onBoot?.({ executor });
  phase("plugin boot");
  // The platform repo rides into the async checks because one of them reads it: the release grammar
  // the Manager enforces against the build plane's copy of it (selfchecks.ts,
  // checkReleaseGrammarMirror). It is the same port every registration write goes through, so the
  // check reads what the runs read, and it is absent on a Manager without onboarding — the check
  // then skips instead of reporting a comparison it never made.
  const checks = [
    ...runSelfChecks({ db, config, store, bus, runDefinitions }),
    ...(await runAsyncSelfChecks({ db, config, runDefinitions, ...(platformRepo ? { platformRepo } : {}), githubApp })),
    ...(await Promise.all(active.flatMap((p) => p.wiring.selfChecks?.() ?? []).map((check) => check()))),
  ];
  phase("self-checks");
  assertBlockingChecksPass(checks);
  // A blocking failure has thrown by now, so what is left is what boot goes on WITH. /readyz carries
  // only a check's name and verdict, so the detail — which literals differ, which file could not be
  // read — is said here or nowhere.
  for (const c of checks) {
    if (c.kind === "skipped") logger.info({ check: c.name, detail: c.detail }, "self-check skipped");
    else if (!c.ok) logger.warn({ check: c.name, detail: c.detail }, "self-check degraded");
  }
  const session = new SessionCodec(db.db, config);
  const loginTx = new LoginTxCodec(db.db);
  const oidc = createOidcAdapter(config, logger);
  phase("oidc");
  // GitHub adapter — ONE instance for Branches + Reset. Absent when GITHUB_REPO/GITHUB_WRITE_PAT
  // are unset — the routes then answer 501 NOT_CONFIGURED, never a quiet no-op.
  const github = config.github ? createGitHubPlatform(config.github) : undefined;
  // hostyour-cloud as ONE carrier of the pin search: its branch list over the REST API, its files
  // over the platform repo's per-branch worktree — the same two adapters the registrations already
  // ride, composed here so the release surface reads the branches the reaper reads. Both halves have
  // to be present: without either there is no walk to make, and the surface says so rather than
  // answering with an empty pin set.
  const readPlatformAppPins =
    github && platformRepo
      ? () =>
          searchPlatformApps({
            booksBranch: platformRepo.booksBranch,
            listBranches: () => github.listBranches(),
            withBranch: (branch, fn) => platformRepo.withBranch(branch, fn),
          })
      : undefined;
  const emergencyStore = new EmergencyStore();
  const emergencyDeps = { config, session, store: emergencyStore, db: db.db, logger };
  const emergencyApp = createEmergencyApp(emergencyDeps);
  const getReadiness = (): ReadyzView => readinessOf(checks);
  const app = createApp({
    config,
    logger,
    getReadiness,
    session,
    registerAuth: (a) => registerAuthRoutes(a, { config, oidc, session, loginTx, db: db.db, logger }),
    registerProtected: (a) => {
      registerRunRoutes(a, { executor, db: db.db, bus, config, logger });
      registerClustersRoutes(a, { db: db.db, storeMode: () => (store.mode() === "plaintext" ? "plaintext" : "sealed"), logger });
      registerServerRoutes(a, { db: db.db, creds: store, actor: runActor, probe: new NetTcpProbe() });
      // The mail DNS of the installation, measured at public resolvers, and beside it every record
      // this installation is responsible for at the DNS provider. Both read-only: publishing and
      // removing are runs, so what a record costs is always planned and approved.
      registerMailRoutes(a, mailDns);
      registerDnsRoutes(a, dnsInventory);
      registerBranchRoutes(a, { db: db.db, config, ...(github ? { github } : {}) });
      // Which version each of an installation's platform apps runs, riding the pin search bound above.
      registerReleaseRoutes(a, { db: db.db, ...(readPlatformAppPins ? { readPlatformAppPins } : {}) });
      // Consumer onboarding routes. The read path (the consumer list) is always live; the mutating
      // triggers answer 501 NOT_CONFIGURED unless the onboarding Run family is wired (buildUnits
      // above registered it with its real git/kube/vault/gate-runner adapters).
      // store: the onboard POST seals the operator's raw repo PAT into the credential store BEFORE
      // the run exists — only the sealed reference enters the executor.
      // What sizes ONE unit and puts it on a size; the size table itself is the unit plugin's.
      registerBackupRoutes(a, { db: db.db, backupsWired: units.backupsWired });
      registerSetSizeRoutes(a, { db: db.db, executor, ...(units.registrations ? { registrations: units.registrations } : {}), onboardingEnabled: units.enabled, tenantEnabled: units.tenantEnabled });
      registerConsumerRoutes(a, { executor, db: db.db, store, onboardingEnabled: units.enabled, ...(units.github ? { github: units.github } : {}), ...(units.platformGitHub ? { platformGitHub: units.platformGitHub } : {}), ...(units.resolver ? { resolver: units.resolver } : {}), ...(units.registrations ? { registrations: units.registrations } : {}), ...(platformRepo ? { platformRepo } : {}), githubApp });
      registerOnboardPrefillRoute(a, { onboardingEnabled: units.enabled, db: db.db, store, ...(units.github ? { github: units.github } : {}), ...(units.platformGitHub ? { platformGitHub: units.platformGitHub } : {}), ...(platformRepo ? { platformRepo } : {}), githubApp });
      // Tenant (multi-app) onboarding routes — the SAME thin shape, gated on the tenant family's own
      // flag (DEPLOY_REPO). Registered right after the consumer routes; the read
      // path (tenant list/detail) stays live, the mutating triggers answer 501 until tenantEnabled.
      registerTenantRoutes(a, { executor, db: db.db, onboardingEnabled: units.tenantEnabled, ...(units.tenantResolver ? { resolver: units.tenantResolver } : {}), ...(units.deployRepoUrl ? { deployRepoUrl: units.deployRepoUrl } : {}), ...(units.appCatalog ? { appCatalog: units.appCatalog } : {}), ...(units.activator ? { activator: units.activator } : {}), ...(units.tenantRegistrations ? { registrations: units.tenantRegistrations } : {}), ...(units.tenantVersions ? { versions: units.tenantVersions } : {}), ...(units.tenantLineMoves ? { lineMoves: units.tenantLineMoves } : {}), ...(tenantFollow ? { follower: tenantFollow.follower } : {}), ...(units.resolveUnitApex ? { resolveUnitApex: units.resolveUnitApex } : {}) });
      // The tenant's own apps repository: the run that creates and builds it, gated like the tenant routes.
      registerTenantAppsRepoRoute(a, { executor, tenantEnabled: units.tenantEnabled });
      // The secrets of a standing consumer (#245) — gated like the other consumer triggers.
      const repositoryRoutes = { executor, onboardingEnabled: units.enabled, db: db.db, store, ...(units.github ? { github: units.github } : {}), ...(platformRepo ? { channelStages: () => readChannelStages(platformRepo) } : {}), githubApp };
      registerConsumerSecretsRoute(a, repositoryRoutes);
      registerConsumerReleaseRoute(a, repositoryRoutes);
      // One tenant's own catalog, read through the same closure tenant-add-app judges against.
      registerTenantAppCatalogRoute(a, { db: db.db, store, githubApp, ...(units.tenantRegistrations ? { registrations: units.tenantRegistrations } : {}), ...(units.appCatalog ? { appCatalog: units.appCatalog } : {}) });
      registerResetRoutes(a, {
        config, db: db.db, sqlite: db.sqlite, store, logger,
        github,
        reseedMaster: async () => { stopMasterReconcile(); await seedMaster(db.db, store, config, logger); },
        plugins: compiledPlugins,
      });
      // What each active plugin serves, under /api/<its name>, and the names of the active ones.
      registerPluginRoutes(a, active, { executor });
      registerSpa(a, spaDistDir()); // LAST — the SPA fallback is the catch-all
    },
  });
  phase("http app");
  const reaper = config.registryReaper;
  const reaperCloud = config.github;
  const [deployOwner, deployRepoName] = (config.deployRepo?.repoURL ?? "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").split("/");
  const reaperBooks = booksBranch(db.db, config.master?.fqdn);
  const reaperTenants = tenantRegistrations;
  const reapRegistryLater = reaper && reaperCloud && deployOwner && deployRepoName && reaperBooks && reaperTenants
    ? () => reapRegistry({
      db: db.db, store, githubApp, logger, cloud: reaperCloud, deploy: { owner: deployOwner, repo: deployRepoName }, books: reaperBooks,
      dataDir: config.dataDir, registryHost: reaper.registryHost, dryRun: reaper.dryRun,
      pins: async (signal) => [
        ...(await Promise.all(active.map((p) => p.wiring.pinHits?.(signal) ?? Promise.resolve([])))).flat(),
        ...(await tenantHeldPins(reaperTenants)),
      ],
    })
    : undefined;
  return {
    config,
    logger,
    db,
    store,
    bus,
    runDefinitions,
    executor,
    app,
    emergencyApp,
    serveEmergencySocket: () => void serveAdminSocket(config.adminSocketPath, emergencyDeps),
    checks,
    carryDeployTrunk,
    refreshAppTokens: refreshAppTokensLater,
    mintTenantAppKeys: unit && tenantRegistrations
      ? async () => {
        await ensureTenantAppKeys({ db: db.db, seeder: unit.seeder, registrations: tenantRegistrations, logger });
      }
      : async () => undefined,
    writeTenantAppDatabases: units.writeTenantAppDatabases ? () => units.writeTenantAppDatabases!(db.db) : async () => undefined,
    syncReleaseKits: registrations && consumerRepo
      ? () => syncReleaseKits({
        registrations, writer: consumerRepo, version: config.version, logger,
        credentialFor: (repoURL) => resolveRepoCredentialId({ repoURL, githubApp, owners: (org) => readOwnerIdentity(db.db, org), store }),
        libraryRepos: units.libraryRepos ?? (async () => []),
        refuseWorkflow: (found) => {
          const gate = gateReleaseWorkflow({ found });
          return gate.status === "pass" ? null : `${gate.found}; ${gate.reason ?? ""}`;
        },
      })
      : async (): Promise<void> => undefined,
    reapRegistry: reapRegistryLater,
    syncHeadlampContexts: () =>
      syncHeadlampContexts({ db: db.db, headlamp }).then(
        (said) => logger.info(said),
        (err: unknown) => logger.error({ err }, "the shared Headlamp's slave contexts could not be written"),
      ),
    startTenantFollow: tenantFollow?.start ?? (async (): Promise<void> => undefined),
  };
}
