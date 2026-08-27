import type { Hono } from "hono";
import { loadConfig, type Config } from "../kernel/config.ts";
import { runActor } from "../kernel/actor.ts";
import { createLogger, type Logger } from "../kernel/logger.ts";
import { openDb, type DbHandle } from "../db/client.ts";
import { runSelfChecks, runAsyncSelfChecks, assertBlockingChecksPass, readinessOf, type CheckResult } from "./selfchecks.ts";
import { scheduleTenantCheck } from "./check-tenants-schedule.ts";
import { seedMaster, stopMasterReconcile } from "./seed-master.ts";
import { seedUnitSizes } from "../domains/units/unit-size.ts";
import { createApp } from "../http/app.ts";
import { CredentialStore } from "../security/store.ts";
import { loadOrCreateDataKey } from "../kernel/datakey.ts";
import { VaultKvClient } from "../adapters/vault/vault-kv.ts";
import { RunEventBus } from "../executor/bus.ts";
import { Executor } from "../executor/executor.ts";
import { buildRunDefinitions, type RunDefinitions } from "../domains/runs/run-definitions.ts";
import { buildUnits } from "./wire-units.ts";
import { createSshSession } from "../adapters/ssh/ssh2-session.ts";
import { HttpReleaseDownloads } from "../adapters/downloads/downloads.ts";
import { HttpMetricsQuery } from "../adapters/metrics/metrics-http.ts";
import { SessionCodec } from "../domains/access/session.ts";
import { LoginTxCodec } from "../domains/access/login-tx.ts";
import { registerAuthRoutes } from "../domains/access/routes.ts";
import { createOidcAdapter } from "../adapters/oidc/authentik.ts";
import { EmergencyStore, createEmergencyApp, serveAdminSocket } from "../domains/access/emergency.ts";
import { registerRunRoutes } from "../domains/runs/api.ts";
import { registerClustersRoutes, registerServerRoutes } from "../domains/inventory/api.ts";
import { createGitHubPlatform } from "../adapters/github-platform/github-platform-http.ts";
import { registerBranchRoutes } from "../domains/branches/api.ts";
import { registerReleaseRoutes } from "../domains/releases/api.ts";
import { searchPlatformApps } from "../domains/registry-cleanup/search.ts";
import { registerConsumerRoutes, registerTenantRoutes } from "../domains/units/api.ts";
import { registerUnitSizeRoutes } from "../domains/units/api-unit-sizes.ts";
import { registerResetRoutes } from "../domains/reset/api.ts";
import { registerSpa, spaDistDir } from "../http/spa.ts";
import type { AppEnv } from "../http/app-env.ts";
import type { ReadyzView } from "../../shared/api-types.ts";

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
  const db = openDb(config.dbFile);
  // Secrets backend: Vault when configured (prod), else a local keyfile-encrypted
  // store (dev). Either way the store API is identical to every caller.
  const store = new CredentialStore({
    db: db.db,
    logger,
    ...(config.vault ? { vault: new VaultKvClient(config.vault) } : { dataKey: loadOrCreateDataKey(config.dataDir) }),
  });
  const bus = new RunEventBus();
  // Consumer onboarding: construct the real adapters and register the Run family — but only when the
  // Tekton gate-runner config (ONBOARD_GATE_MANAGER_ADDR) + platform repo are both configured
  // (else defs=[] and the mutating consumer routes answer 501). See wire-units.ts.
  const units = buildUnits(config, store, db.db, logger);
  const runDefinitions = buildRunDefinitions({
    db: db.db,
    ...(units.platformRepo ? { platformRepo: units.platformRepo } : {}),
    // The SAME two settings the platform repo above is built from, as the machine's programs are
    // answered with it: `owner/name`. deploy-host's git_clone row cannot read this off the machine,
    // because the checkout it would be read from is what that row establishes.
    ...(config.github ? { platformOrigin: `${config.github.owner}/${config.github.repo}` } : {}),
    ...(config.ansiwiseServeCommand ? { ansiwiseServeCommand: config.ansiwiseServeCommand } : {}),
    ...(config.ansiwiseDownloadUrl ? { ansiwiseDownloadUrl: config.ansiwiseDownloadUrl } : {}),
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
  }, units.defs);
  const executor = new Executor({
    db: db.db,
    creds: store,
    bus,
    logger,
    runDefinitions,
    sshFactory: createSshSession,
    actor: runActor,
  });
  // Master self-registration (seed-master.ts): make a fresh DB carry the role=master row +
  // its self-SSH key so deploy-slave works with zero manual SQL. If the ESO secret is late, a
  // bounded background reconcile inside seedMaster converges pin+seal without a pod restart
  // (unref'd — if a later blocking check fails boot, the exiting process is not held open).
  // Degrade-friendly by design;
  // a genuine DB fault still surfaces (boot fails loud rather than running half-seeded).
  // The tenant administrator check: a run started on a timer. It is here rather than in a
  // CronJob because it must write into THIS database, which is a ReadWriteOnce volume held by a
  // single replica — the same dependency seed-master.ts states for its own reconcile.
  scheduleTenantCheck(executor, logger);
  await seedMaster(db.db, store, config, logger);
  // The catalog's books branch, brought into being here rather than at the first tenant registration
  // (wire-units.ts ensureBooksBranch). LOG AND CONTINUE on failure: a catalog that is unreachable at
  // start-up must not take the Manager down, and what a failure leaves behind is exactly the state
  // this call was added to end, never a worse one. It is logged at error because this is the only
  // place that can say which branch and why — /readyz carries a verdict, not a reason.
  if (units.ensureBooksBranch) {
    try {
      await units.ensureBooksBranch();
    } catch (err) {
      logger.error(
        { err: String(err) },
        "the catalog's books branch could not be created — the tenant ApplicationSet's git generator has no revision to resolve, so it and the root Application above it stay in error until a tenant is registered",
      );
    }
  }
  // The size table (domains/units/unit-size.ts): fill in any of the three sizes this database
  // does not carry yet, and touch none that it does. Create-only, so an installation that edited a
  // size keeps its figures across every restart — the same rule the Vault seeder follows, and for the
  // same reason: a re-run must never silently re-price a unit that is already running on a value.
  const seededSizes = seedUnitSizes(db.db);
  if (seededSizes.length > 0) logger.info({ sizes: seededSizes }, "unit size table seeded");
  // The platform repo rides into the async checks because one of them reads it: the release grammar
  // the Manager enforces against the build plane's copy of it (selfchecks.ts,
  // checkReleaseGrammarMirror). It is the same port every registration write goes through, so the
  // check reads what the runs read, and it is absent on a Manager without onboarding — the check
  // then skips instead of reporting a comparison it never made.
  const checks = [
    ...runSelfChecks({ db, config, store, bus, runDefinitions }),
    ...(await runAsyncSelfChecks({ db, config, runDefinitions, ...(units.platformRepo ? { platformRepo: units.platformRepo } : {}) })),
  ];
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
  // GitHub adapter — ONE instance for Branches + Reset. Absent when GITHUB_REPO/GITHUB_WRITE_PAT
  // are unset — the routes then answer 501 NOT_CONFIGURED, never a quiet no-op.
  const github = config.github ? createGitHubPlatform(config.github) : undefined;
  // hostyour-cloud as ONE carrier of the pin search: its branch list over the REST API, its files
  // over the platform repo's per-branch worktree — the same two adapters the registrations already
  // ride, composed here so the release surface reads the branches the reaper reads. Both halves have
  // to be present: without either there is no walk to make, and the surface says so rather than
  // answering with an empty pin set.
  const platformRepo = units.platformRepo;
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
      registerClustersRoutes(a, { db: db.db, storeMode: () => (store.mode() === "plaintext" ? "plaintext" : "sealed"), logger, ...(platformRepo ? { platformRepo } : {}) });
      registerServerRoutes(a, { db: db.db, creds: store, executor, actor: runActor, ...(platformRepo ? { platformRepo } : {}) });
      registerBranchRoutes(a, { db: db.db, config, ...(github ? { github } : {}) });
      // Which release each installation stands on, and which version each of its platform apps runs.
      // The app half rides the pin search bound above; the cluster half reads the maps through the
      // same platform repo port every registration write goes through.
      registerReleaseRoutes(a, { db: db.db, ...(platformRepo ? { platformRepo } : {}), ...(readPlatformAppPins ? { readPlatformAppPins } : {}) });
      // Consumer onboarding routes. The read path (the consumer list) is always live; the mutating
      // triggers answer 501 NOT_CONFIGURED unless the onboarding Run family is wired (buildUnits
      // above registered it with its real git/kube/vault/gate-runner adapters).
      // store: the onboard POST seals the operator's raw repo PAT into the credential store BEFORE
      // the run exists — only the sealed reference enters the executor.
      // The size table: a read and one write, both unconditional — they need no adapter, and what
      // this installation sells is a fact whether or not onboarding is currently configured.
      registerUnitSizeRoutes(a, { db: db.db, executor, ...(units.registrations ? { registrations: units.registrations } : {}), onboardingEnabled: units.enabled, tenantEnabled: units.tenantEnabled });
      registerConsumerRoutes(a, { executor, db: db.db, store, onboardingEnabled: units.enabled, ...(units.resolver ? { resolver: units.resolver } : {}), ...(units.registrations ? { registrations: units.registrations } : {}), ...(units.platformRepo ? { platformRepo: units.platformRepo } : {}) });
      // Tenant (multi-app) onboarding routes — the SAME thin shape, gated on the tenant family's own
      // flag (the catalog PAT). Registered right after the consumer routes; the read
      // path (tenant list/detail) stays live, the mutating triggers answer 501 until tenantEnabled.
      registerTenantRoutes(a, { executor, db: db.db, onboardingEnabled: units.tenantEnabled, ...(units.tenantResolver ? { resolver: units.tenantResolver } : {}), ...(units.catalogRepoUrl ? { catalogRepoUrl: units.catalogRepoUrl } : {}), ...(units.appCatalog ? { appCatalog: units.appCatalog } : {}), ...(units.activator ? { activator: units.activator } : {}), ...(units.tenantRegistrations ? { registrations: units.tenantRegistrations } : {}), ...(units.resolveUnitApex ? { resolveUnitApex: units.resolveUnitApex } : {}) });
      registerResetRoutes(a, {
        config, db: db.db, sqlite: db.sqlite, store, logger,
        github,
        reseedMaster: async () => { stopMasterReconcile(); await seedMaster(db.db, store, config, logger); },
      });
      registerSpa(a, spaDistDir()); // LAST — the SPA fallback is the catch-all
    },
  });
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
  };
}
