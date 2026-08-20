import type { Hono } from "hono";
import type { Db } from "../../db/client.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { ClustersView, StoreMode } from "../../../shared/api-types.ts";
import { listRuns } from "../../executor/read.ts";
import { listLocks } from "../../executor/locks.ts";
import { listServers, getServer } from "./read.ts";
import { readClusterReleases } from "./cluster-marking.ts";
import { createServer, deleteServer, openBootstrapPassword, serverCredFlags, CreateServerInput } from "./write.ts";
import { createOperatorKey, deleteOperatorKey, listOperatorKeys, CreateOperatorKeyInput } from "./operator-keys.ts";
import { errNotFound } from "../../kernel/errors.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Executor } from "../../executor/executor.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";
import { isMasterRole } from "../../../shared/enums.ts";

export interface ClustersApiDeps {
  db: Db;
  storeMode: () => StoreMode; // already mapped in wire so inventory stays decoupled from security
  logger: Logger;
  /** The books branch the cluster maps stand on. Absent on a Controller whose platform repo is not
   *  configured — every server's release then reads "unknown" with that as its reason, which is the
   *  same degrade-loud contract the mutating onboarding routes follow. */
  platformRepo?: PlatformRepo;
}

export interface ServerApiDeps {
  db: Db;
  creds: CredentialStore;
  executor: Executor;
  actor: () => string;
  /** As ClustersApiDeps.platformRepo — /api/servers projects the same ServerView. */
  platformRepo?: PlatformRepo;
}

/**
 * The single-screen clusters snapshot. needsYou = runs awaiting approval, running =
 * live runs — the two action queues the UI leads with. sources report per-collector wiring;
 * only inventory (the DB) is wired, the rest are honestly "unwired".
 *
 * `servers` = the MANAGED servers only (the slaves). The master — this controller itself —
 * is not something it manages, so it must never inflate the managed count (UI mirrors reality
 * 1:1); it rides the dedicated `master` field instead.
 *
 * Async because of ONE read: the cluster maps, which state the release each cluster stands on. It is
 * made once for the whole view and folded onto every projection; a failure to make it does not fail
 * the view — it becomes the reason each row's release reads "unknown".
 */
export async function buildClustersView(db: Db, storeMode: StoreMode, platformRepo?: PlatformRepo): Promise<ClustersView> {
  const runs = listRuns(db);
  const needsYou = runs.filter((r) => r.status === "planned");
  const inventory = listServers(db, undefined, await readClusterReleases(platformRepo));
  return {
    asOf: Date.now(),
    verdict: needsYou.length > 0 ? "warn" : "ok",
    needsYou,
    running: runs.filter((r) => r.status === "running"),
    servers: inventory.filter((s) => !isMasterRole(s.role)),
    master: inventory.find((s) => isMasterRole(s.role)) ?? null,
    sources: { inventory: "ok", argo: "unwired", vault: "unwired", alerts: "unwired", prom: "unwired", ssh: "unwired" },
    storeMode,
  };
}

export function registerClustersRoutes(app: Hono<AppEnv>, deps: ClustersApiDeps): void {
  app.get("/api/clusters", async (c) => c.json(await buildClustersView(deps.db, deps.storeMode(), deps.platformRepo)));
  // The whole lock table, and the ONE read that has no browser caller: nothing in web/src lists locks
  // yet. It is served anyway because a refused approve answers 409 with the single claim that
  // collided (resource, key, holderRunId) and nothing else, so neither the operator nor a reader of
  // this code can see what ELSE is held or who holds it — which is the question behind every "why can
  // no run start" and behind deciding whether a claim needs to be platform-wide or per cluster.
  app.get("/api/locks", (c) => c.json(listLocks(deps.db)));
}

/** Server inventory routes. Create can
 *  store a bootstrap password (sealed); the list offers 1-click adopt. All behind the auth
 *  chokepoint + CSRF. */
export function registerServerRoutes(app: Hono<AppEnv>, deps: ServerApiDeps): void {
  const { db, creds, executor } = deps;

  app.get("/api/servers", async (c) =>
    c.json({ servers: listServers(db, await serverCredFlags(creds), await readClusterReleases(deps.platformRepo)) }),
  );

  app.post("/api/servers", async (c) => {
    const input = CreateServerInput.parse(await c.req.json().catch(() => ({})));
    return c.json({ server: await createServer(db, creds, deps.actor(), input) }, 201);
  });

  app.delete("/api/servers/:id", async (c) => {
    await deleteServer(db, creds, deps.actor(), c.req.param("id"));
    return c.json({ ok: true });
  });

  // The operator-key surface: a human's own public key, held so the platform can place it on a
  // machine and take it off again. Read/write only — the three run kinds that touch a host are runs,
  // reached through POST /api/runs like every other, because putting a key on a machine is an act
  // with a plan, an approval and a log and not a row this route could flip.
  app.get("/api/operator-keys", (c) => c.json({ keys: listOperatorKeys(db) }));

  app.post("/api/operator-keys", async (c) => {
    const input = CreateOperatorKeyInput.parse(await c.req.json().catch(() => ({})));
    return c.json({ key: createOperatorKey(db, deps.actor(), input) }, 201);
  });

  // Forgets the row; it takes nothing off any machine. The domain refuses while a stored reading
  // still finds the key on a host, because the removal run kind needs this row to name the line.
  app.delete("/api/operator-keys/:id", (c) => {
    deleteOperatorKey(db, deps.actor(), c.req.param("id"));
    return c.json({ ok: true });
  });

  // 1-click adopt from the list. Plans adopt, then approves with the STORED bootstrap password
  // (or one supplied in the body). If neither is available the planned run is returned anyway —
  // the Run screen's ceremony prompts for the password (graceful fallback).
  app.post("/api/servers/:id/adopt", async (c) => {
    const id = c.req.param("id");
    // Presence only — the projection is discarded, so no cluster map is read for it.
    if (!getServer(db, id, undefined, { ok: false, reason: "the adopt route only asks whether the server exists" })) {
      throw errNotFound(`server ${id}`);
    }
    const body = (await c.req.json().catch(() => ({}))) as { password?: string; intendedDomain?: string };
    const { runId } = await executor.plan("adopt", {
      serverId: id,
      ...(body.intendedDomain ? { intendedDomain: body.intendedDomain } : {}),
    });
    const pw = body.password ? Buffer.from(body.password, "utf8") : await openBootstrapPassword(creds, id, runId);
    if (pw) await executor.approve(runId, { "adopt-password": pw });
    return c.json({ runId, approved: Boolean(pw) }, 202);
  });
}
