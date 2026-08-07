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
  void executor.resumeOnBoot();

  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    logger.info({ port: info.port }, "listening");
  });

  // Break-glass: a second listener on 127.0.0.1:8485 only — never Traefik-routed, so
  // WAN-unreachable by construction. Tokens are minted solely through the 0700 admin.sock.
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
