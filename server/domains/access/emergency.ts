import { randomBytes } from "node:crypto";
import { chmodSync, statSync, unlinkSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
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
 *
 * The token exists for the BROWSER case: the redeem URL is pasted into one, and the redeem sets
 * the session cookie. A caller that is not a browser takes the session straight off the socket
 * (`POST /auth/session` on createAdminSocketApp) — same boundary, same session, no round trip.
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

/**
 * WHICH DOOR a break-glass session came through: a person pasting the redeem URL into a browser,
 * or a program taking the session straight off the socket. Two kinds of caller, ONE act — the
 * sealed session is the same value, minted from the same authority (write permission on the 0700
 * admin.sock, never an IdP), carrying the same `sub`, `groups` and `via`. So this is a VALUE the
 * one audit shape carries, not a second action name beside `operator.login`: splitting the action
 * would leave `WHERE action = 'operator.login'` showing half the mints and saying nothing about the
 * half it hid, which is exactly how a trail starts lying. That query is not hypothetical — the
 * dependency-cruiser rule `only-audit-writer` keeps every module out of schema/audit, so nothing in
 * this process reads the table and every reader there is asks for an action by name over SQL.
 * A key added inside `detail_json` is invisible to a query that does not ask for it; a renamed or
 * split action is not.
 *
 * The door is what the mint honestly knows. It does not know that the program is onboarding a
 * consumer, and it may not learn it from anything the caller says.
 *
 * AND THE TWO DOORS ARE NOT EQUALLY STRONG EVIDENCE. `admin_sock` PROVES the caller was not a
 * browser: no browser opens an AF_UNIX socket. `browser_redeem` only PRESUMES a person, because a
 * program running on this host can mint a token and redeem the URL itself just as well — needing
 * the redeem path is not the same as being unable to use it. Both spoof directions sit behind the
 * same host-access boundary, so no privilege moves either way; what would move is a reader's
 * confidence, and that is why the asymmetry is written here rather than left to be assumed.
 */
type ArrivedBy = "browser_redeem" | "admin_sock";

/** The one place a break-glass session comes into existence, and the one audit row that records
 *  it. Both ways in — the :8485 redeem and the admin.sock session route — call this, so there is a
 *  single minting path and a single audited shape whichever way the operator arrived.
 *
 *  The row carries TWO facts, and they are not the same fact. `method` names the AUTHORITY the
 *  session rests on — the same word `via` carries on the session itself (domains/access/session.ts)
 *  — and `arrivedBy` names the DOOR. reset/api.ts reads the authority and never the door; an audit
 *  reader asking which of the two callers this was reads the door. Both belong in the one row
 *  because the row is what answers "who did this, and how did they get in" when no log is kept.
 *
 *  `arrivedBy` reaches the audit row and the log line as the SAME value, so the two records of one
 *  mint compare equal instead of being an English sentence beside a slug. The log stays because a
 *  session minted here is the highest privilege this process grants and says so on its way out. */
async function mintEmergencySession(deps: EmergencyDeps, arrivedBy: ArrivedBy): Promise<string> {
  const session = await deps.session.mint({ sub: EMERGENCY_OPERATOR, groups: [deps.config.oidc.adminsGroup], via: "emergency" });
  writeAudit(deps.db, { actor: EMERGENCY_OPERATOR, action: "operator.login", detail: { method: "emergency", arrivedBy } });
  deps.logger.warn({ action: "break_glass.session", arrivedBy }, `break-glass session minted via ${arrivedBy}`);
  return session;
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
    const session = await mintEmergencySession(deps, "browser_redeem");
    setCookie(c, sessionCookieName(deps.config), session, { httpOnly: true, secure: deps.config.cookieSecure, sameSite: "Lax", path: "/" });
    return c.redirect("/", 302);
  });
  return app;
}

/**
 * The admin.sock app. Carries no chokepoint and is never mounted on :8484 or :8485: the socket
 * file's 0700 mode IS the boundary in front of both routes, because connecting to a UNIX socket
 * needs only write permission on the file. Nothing here is reachable over any network — AF_UNIX
 * has no address a peer off the machine can name, and no browser can open one.
 */
export function createAdminSocketApp(deps: EmergencyDeps): Hono {
  const app = new Hono();

  // What the raw line wrote, now an HTTP body: a single-use token and the :8485 URL that redeems
  // it. This stays because it is the BROWSER's way back in — a session value cannot be pasted into
  // a browser, and recovering the console when the IdP is down is what break-glass is for.
  app.post("/auth/break-glass", (c) => {
    const token = deps.store.mint();
    deps.logger.warn({ action: "break_glass.minted" }, "break-glass token minted via admin.sock");
    return c.json({ url: `http://127.0.0.1:${deps.config.emergencyPort}/auth/emergency?token=${token}` });
  });

  // The sealed session itself, for a caller that is not a browser. It is carried back as
  // `Authorization: Bearer` (http/middleware/chokepoint.ts) — the SAME sealed value the cookie
  // holds, verified by the same SessionCodec, gated by the same chokepoint.
  //
  // Why this is not the one-unit path hostyour-manager#12 forbids: #12 refuses a MECHANISM that
  // only one unit travels — a manager onboarded by machinery no consumer exercises. This route
  // adds no mechanism. It issues the ordinary operator session and stops; every consumer, the
  // manager included, is then onboarded through the same /api routes, the same chokepoint, the
  // same audit and the same Executor a browser drives. What is unit-specific about a caller is
  // what it ASKS FOR after this line, and that surface is the shared one. The boundary here is
  // host access on the master, which is not per-unit either: there is exactly one admin.sock and
  // everything running as the service user reaches the same one.
  //
  // No lifetime is returned, because none could be kept: the session goes idle-stale on the clock
  // in session.ts and a caller learns that from a 401. The socket is always there to mint again.
  app.post("/auth/session", async (c) => c.json({ session: await mintEmergencySession(deps, "admin_sock") }));

  return app;
}

/**
 * Serves createAdminSocketApp over the 0700 admin.sock. Wired at boot. AF_UNIX socket files and
 * their modes are Linux semantics, so the mode is asserted where the check battery runs on Linux;
 * a dev box without AF_UNIX degrades to the warn below.
 *
 * HTTP rather than a raw line so the socket can carry more than one answer and say which one
 * failed. `localhost` is the default authority for a client that sends no Host header; AF_UNIX has
 * no host of its own, and the value never leaves the URL the router matches against.
 */
export function serveAdminSocket(socketPath: string, deps: EmergencyDeps): HttpServer {
  const server = createHttpServer(getRequestListener(createAdminSocketApp(deps).fetch, { hostname: "localhost" }));
  // A stale socket file left by a previous unclean shutdown makes listen() fail with
  // EADDRINUSE — the inode exists but nothing is bound to it, so the socket answers nothing and is
  // silently dead every boot until the file is removed. The controller is single-replica (RWO
  // /data), so any pre-existing admin.sock is OURS-but-dead; unlink it before binding. Guarded to a
  // real socket so a mis-set DATA_DIR can never make us delete an arbitrary file.
  try {
    if (statSync(socketPath).isSocket()) unlinkSync(socketPath);
  } catch {
    // ENOENT (clean boot) or un-stat-able — nothing to clear; listen() proceeds.
  }
  // A listen failure (e.g. no AF_UNIX on the dev box) must never crash the controller — the
  // :8485 HTTP listener is the reachable half; only the socket's two routes are unavailable.
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
