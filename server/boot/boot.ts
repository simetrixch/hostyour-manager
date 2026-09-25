import { serve } from "@hono/node-server";
import { wire } from "./wire.ts";
import { scheduleCatalogCarry } from "./carry-catalog-schedule.ts";
import { scheduleAppTokenRefresh } from "./refresh-app-tokens-schedule.ts";

/**
 * Ordered boot. LAW 0: boots with the whole world down — the only hard
 * dependencies are DATA_DIR + manager.db. Kube / OIDC discovery / git are lazy and
 * visibly degrading; they join in later increments.
 */
export async function boot(): Promise<void> {
  const wired = await wire();
  const { config, logger, app, executor } = wired;
  logger.info(
    {
      publicUrl: config.publicUrl,
      redirectUri: config.redirectUri,
      cookieSecure: config.cookieSecure,
      origin: config.origin,
      port: config.port,
    },
    "manager starting",
  );

  // Resume interrupted runs immediately (no locked boot while the store is plaintext).
  //
  // NOT awaited, and there is nothing to catch. It resolves only once every resumed run has settled,
  // so awaiting it would hold the listener below down for the length of the longest onboarding; and
  // it does not reject — the recovery records its own failure and lets the boot go on, because a run
  // it could not read or normalize is still a row the next boot finds.
  void executor.resumeOnBoot();

  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    logger.info({ port: info.port }, "listening");
  });

  // Break-glass: a second listener on 127.0.0.1:8485 only — never Traefik-routed, so
  // WAN-unreachable by construction. It redeems tokens; both the tokens and the sessions a
  // programmatic caller carries as `Authorization: Bearer` come solely off admin.sock, whose
  // mode the deployment sets (config.ts ADMIN_SOCKET_MODE).
  serve({ fetch: wired.emergencyApp.fetch, port: config.emergencyPort, hostname: "127.0.0.1" }, (info) => {
    logger.info({ port: info.port }, "break-glass listener up (127.0.0.1 only)");
  });
  wired.serveEmergencySocket();
  // The one slow act of boot runs behind the listening server, so /healthz answers from the first
  // second and the liveness probe has nothing to kill (#166).
  // The carry never rejects, so the registrations follow it: every standing registration brought to
  // this release's schema, once per boot and never on a timer — a schema changes only with a release,
  // and a release boots the Manager. After the carry rather than beside it only so the log reads in
  // order; the carry brings charts and rewrites no registration.
  void wired.carryCatalogTrunk().then(wired.migrateRegistrations);
  // ... and again every ten minutes, so a change on the catalog's trunk reaches a standing tenant
  // without a boot or a plan (#169).
  scheduleCatalogCarry(wired.carryCatalogTrunk, logger);
  // The App tokens behind the build repo-pat entries: rewritten once now, behind the listener, and
  // then every 45 minutes — a token lives 60, so a unit whose credential is the platform's GitHub
  // App can release at any hour, not only the one after its onboarding (#184). The same tick takes a
  // token repository Secret off every live unit the App reaches (repo-credential-sweep.ts).
  void wired.refreshAppTokens();
  scheduleAppTokenRefresh(wired.refreshAppTokens, logger);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down");
    void executor.shutdown().finally(() => {
      server.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
