import { serve } from "@hono/node-server";
import { wire } from "./wire.ts";

/**
 * Ordered boot. LAW 0: boots with the whole world down — the only hard
 * dependencies are DATA_DIR + controller.db. Kube / OIDC discovery / git are lazy and
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
    "controller starting",
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
