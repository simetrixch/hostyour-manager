import { randomBytes } from "node:crypto";
import { chmodSync, statSync, unlinkSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Config } from "../../kernel/config.ts";
import type { Db } from "../../db/client.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ApiError } from "../../../shared/api-types.ts";
import { SessionCodec, sessionCookieName } from "./session.ts";
import { writeAudit } from "../../db/audit-writer.ts";

const EMERGENCY_OPERATOR = "op_emergency"; // seeded at schema creation; runs.started_by needs a row to point at

/**
 * Break-glass — closes the chicken-and-egg: recover access even when
 * the IdP is down. NO standing recovery credential exists on the D-1 host. A single-use token
 * is minted only through the 0700 `admin.sock` (host access IS the honest boundary) and
 * redeemed once through the :8485 listener, which is published on 127.0.0.1 only and never
 * Traefik-routed — WAN-unreachability is structural (a port split), not a peer-IP guess.
 */
export class EmergencyStore {
  private readonly tokens = new Set<string>();

  mint(): string {
    const token = randomBytes(32).toString("base64url");
    this.tokens.add(token);
    return token;
  }

  /** Single-use: returns true and consumes iff the token was outstanding. */
  redeem(token: string): boolean {
    return this.tokens.delete(token);
  }
}

export interface EmergencyDeps {
  config: Config;
  session: SessionCodec;
  store: EmergencyStore;
  db: Db;
  logger: Logger;
}

/** The :8485-only listener app. Serves exactly one route; carries no chokepoint (that is the
 *  whole point) and is never mounted on the main :8484 app. */
export function createEmergencyApp(deps: EmergencyDeps): Hono {
  const app = new Hono();
  app.get("/auth/emergency", async (c) => {
    const token = c.req.query("token") ?? "";
    if (!deps.store.redeem(token)) {
      return c.json({ code: "UNAUTHENTICATED", message: "Invalid or already-used break-glass token" } satisfies ApiError, 401);
    }
    const session = await deps.session.mint({ sub: EMERGENCY_OPERATOR, groups: [deps.config.oidc.adminsGroup], via: "emergency" });
    writeAudit(deps.db, { actor: EMERGENCY_OPERATOR, action: "operator.login", detail: { method: "emergency" } });
    setCookie(c, sessionCookieName(deps.config), session, { httpOnly: true, secure: deps.config.cookieSecure, sameSite: "Lax", path: "/" });
    return c.redirect("/", 302);
  });
  return app;
}

/**
 * Mint-on-connect over the 0700 admin.sock: the service user runs a CLI that connects and is
 * handed the one-time redeem URL. Wired at boot. AF_UNIX socket files and their modes are Linux
 * semantics, so the mode is asserted where the check battery runs on Linux; a dev box without
 * AF_UNIX degrades to the warn below.
 */
export function serveAdminSocket(socketPath: string, deps: EmergencyDeps): NetServer {
  const server = createNetServer((sock) => {
    const token = deps.store.mint();
    sock.end(`http://127.0.0.1:${deps.config.emergencyPort}/auth/emergency?token=${token}\n`);
    deps.logger.warn({ action: "break_glass.minted" }, "break-glass token minted via admin.sock");
  });
  // A stale socket file left by a previous unclean shutdown makes listen() fail with
  // EADDRINUSE — the inode exists but nothing is bound to it, so mint-on-connect is silently
  // dead every boot until the file is removed. The controller is single-replica (RWO /data),
  // so any pre-existing admin.sock is OURS-but-dead; unlink it before binding. Guarded to a
  // real socket so a mis-set DATA_DIR can never make us delete an arbitrary file.
  try {
    if (statSync(socketPath).isSocket()) unlinkSync(socketPath);
  } catch {
    // ENOENT (clean boot) or un-stat-able — nothing to clear; listen() proceeds.
  }
  // A listen failure (e.g. no AF_UNIX on the dev box) must never crash the controller — the
  // :8485 HTTP listener is the reachable half; only the socket mint is unavailable.
  server.on("error", (err: unknown) => deps.logger.warn({ err: String(err) }, "admin.sock unavailable"));
  server.listen(socketPath, () => {
    // The bind creates the socket file with a umask-derived mode (0755 under the image's 022), and
    // connecting to a UNIX socket needs only WRITE permission on the file — so the mode IS the
    // boundary in front of the unauthenticated token mint, and it is set explicitly rather than
    // inherited: a umask or base-image change must never widen who can be handed an admin session.
    // If the mode cannot be set, the listener is torn down — better no break-glass than one whose
    // only boundary is unknown.
    try {
      chmodSync(socketPath, 0o700);
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "admin.sock mode could not be set to 0700 — closing the break-glass mint");
      server.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // The file may already be gone; the close above is what mattered.
      }
    }
  });
  return server;
}
