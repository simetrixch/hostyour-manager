import type { Hono } from "hono";
import { loadConfig, type Config } from "../kernel/config.ts";
import { runActor } from "../kernel/actor.ts";
import { createLogger, type Logger } from "../kernel/logger.ts";
import { openDb, type DbHandle } from "../db/client.ts";
import { runSelfChecks, runAsyncSelfChecks, assertBlockingChecksPass, type CheckResult } from "./selfchecks.ts";
import { seedMaster, stopMasterReconcile } from "./seed-master.ts";
import { seedUnitSizes } from "../domains/onboarding/unit-size.ts";
import { createApp } from "../http/app.ts";
import { CredentialStore } from "../security/store.ts";
import { loadOrCreateDataKey } from "../kernel/datakey.ts";
import { VaultKvClient } from "../adapters/vault/vault-kv.ts";
import { RunEventBus } from "../executor/bus.ts";
import { Executor } from "../executor/executor.ts";
import { buildRegistry, type Registry } from "../domains/runs/registry.ts";
import { buildOnboarding } from "./wire-onboarding.ts";
import { createSshSession } from "../adapters/ssh/ssh2-session.ts";
import { SessionCodec } from "../domains/access/session.ts";
import { LoginTxCodec } from "../domains/access/login-tx.ts";
import { registerAuthRoutes } from "../domains/access/routes.ts";
import { createOidcAdapter } from "../adapters/oidc/authentik.ts";
import { EmergencyStore, createEmergencyApp, serveAdminSocket } from "../domains/access/emergency.ts";
import { registerRunRoutes } from "../domains/runs/api.ts";
import { registerClustersRoutes, registerServerRoutes } from "../domains/inventory/api.ts";
import { createGitHubClient } from "../adapters/github/github.ts";
import { registerBranchRoutes } from "../domains/branches/api.ts";
import { registerConsumerRoutes, registerTenantRoutes } from "../domains/onboarding/api.ts";
import { registerUnitSizeRoutes } from "../domains/onboarding/api-unit-sizes.ts";
import { registerResetRoutes } from "../domains/reset/api.ts";
import { registerSpa, spaDistDir } from "../http/spa.ts";
import { join } from "node:path";
import type { AppEnv } from "../http/app-env.ts";
import type { ReadyzView } from "../../shared/api-types.ts";

export interface Wired {
  config: Config;
  logger: Logger;
  db: DbHandle;
  store: CredentialStore;
  bus: RunEventBus;
  registry: Registry;
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
  // Tekton gate-runner config (ONBOARD_GATE_CONTROLLER_ADDR) + platform repo are both configured
  // (else defs=[] and the mutating consumer routes answer 501). See wire-onboarding.ts.
  const onboarding = buildOnboarding(config, store, db.db, logger);
  const registry = buildRegistry({ db: db.db, ...(onboarding.platformRepo ? { platformRepo: onboarding.platformRepo } : {}) }, onboarding.defs);
  const executor = new Executor({
    db: db.db,
    creds: store,
    bus,
    logger,
    registry,
    sshFactory: createSshSession,
    actor: runActor,
  });
  // Master self-registration (seed-master.ts): make a fresh DB carry the role=master row +
  // its self-SSH key so deploy-slave works with zero manual SQL. If the ESO secret is late, a
  // bounded background reconcile inside seedMaster converges pin+seal without a pod restart
  // (unref'd — if a later blocking check fails boot, the exiting process is not held open).
  // Degrade-friendly by design;
  // a genuine DB fault still surfaces (boot fails loud rather than running half-seeded).
  await seedMaster(db.db, store, config, logger);
  // The size table (domains/onboarding/unit-size.ts): fill in any of the three sizes this database
  // does not carry yet, and touch none that it does. Create-only, so an installation that edited a
  // size keeps its figures across every restart — the same rule the Vault seeder follows, and for the
  // same reason: a re-run must never silently re-price a unit that is already running on a value.
  const seededSizes = seedUnitSizes(db.db);
  if (seededSizes.length > 0) logger.info({ sizes: seededSizes }, "unit size table seeded");
  const checks = [...runSelfChecks({ db, config, store, bus, registry }), ...(await runAsyncSelfChecks({ db, config }))];
  assertBlockingChecksPass(checks);
  const session = new SessionCodec(db.db, config);
  const loginTx = new LoginTxCodec(db.db);
  const oidc = createOidcAdapter(config, logger);
  // GitHub adapter — ONE instance for Branches + Reset. Absent when GITHUB_REPO/GITHUB_WRITE_PAT
  // are unset — the routes then answer 501 NOT_CONFIGURED, never a quiet no-op.
  const github = config.github ? createGitHubClient(config.github) : undefined;
  const emergencyStore = new EmergencyStore();
  const emergencyDeps = { config, session, store: emergencyStore, db: db.db, logger };
  const emergencyApp = createEmergencyApp(emergencyDeps);
  const getReadiness = (): ReadyzView => ({
    ok: checks.every((c) => c.kind !== "blocking" || c.ok),
    checks: checks.map((c) => ({ name: c.name, ok: c.ok })),
  });
  const app = createApp({
    config,
    logger,
    getReadiness,
    session,
    registerAuth: (a) => registerAuthRoutes(a, { config, oidc, session, loginTx, db: db.db, logger }),
    registerProtected: (a) => {
      registerRunRoutes(a, { executor, db: db.db, bus, config, logger });
      registerClustersRoutes(a, { db: db.db, storeMode: () => (store.mode() === "plaintext" ? "plaintext" : "sealed"), logger });
      registerServerRoutes(a, { db: db.db, creds: store, executor, actor: runActor });
      registerBranchRoutes(a, { db: db.db, config, ...(github ? { github } : {}) });
      // Consumer onboarding routes. The read path (the consumer list) is always live; the mutating
      // triggers answer 501 NOT_CONFIGURED unless the onboarding Run family is wired (buildOnboarding
      // above registered it with its real git/kube/vault/gate-runner adapters).
      // store: the onboard POST seals the operator's raw repo PAT into the credential store BEFORE
      // the run exists — only the sealed reference enters the executor.
      // The size table: a read and one write, both unconditional — they need no adapter, and what
      // this installation sells is a fact whether or not onboarding is currently configured.
      registerUnitSizeRoutes(a, { db: db.db, executor, ...(onboarding.registry ? { registry: onboarding.registry } : {}), onboardingEnabled: onboarding.enabled, tenantEnabled: onboarding.tenantEnabled });
      registerConsumerRoutes(a, { executor, db: db.db, store, onboardingEnabled: onboarding.enabled, ...(onboarding.resolver ? { resolver: onboarding.resolver } : {}), ...(onboarding.registry ? { registry: onboarding.registry } : {}), ...(onboarding.platformRepo ? { platformRepo: onboarding.platformRepo } : {}) });
      // Tenant (multi-app) onboarding routes — the SAME thin shape, gated on the tenant family's own
      // flag (the catalog PAT). Registered right after the consumer routes; the read
      // path (tenant list/detail) stays live, the mutating triggers answer 501 until tenantEnabled.
      registerTenantRoutes(a, { executor, db: db.db, onboardingEnabled: onboarding.tenantEnabled, ...(onboarding.tenantResolver ? { resolver: onboarding.tenantResolver } : {}), ...(onboarding.catalogRepoUrl ? { catalogRepoUrl: onboarding.catalogRepoUrl } : {}), ...(onboarding.appCatalog ? { appCatalog: onboarding.appCatalog } : {}), ...(onboarding.activator ? { activator: onboarding.activator } : {}), ...(onboarding.tenantRegistry ? { registry: onboarding.tenantRegistry } : {}), ...(onboarding.resolveUnitApex ? { resolveUnitApex: onboarding.resolveUnitApex } : {}) });
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
    registry,
    executor,
    app,
    emergencyApp,
    serveEmergencySocket: () => void serveAdminSocket(join(config.dataDir, "admin.sock"), emergencyDeps),
    checks,
  };
}
