import type { Hono } from "hono";
import type { Db } from "../../db/client.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AppEnv } from "../../http/app-env.ts";
import type { ClustersView, StoreMode } from "../../../shared/api-types.ts";
import { listRuns } from "../../executor/read.ts";
import { listLocks } from "../../executor/locks.ts";
import { listServers } from "./read.ts";
import { createServer, deleteServer, serverCredFlags, CreateServerInput } from "./write.ts";
import { restateMachineIdentity, RestateMachineIdentityInput } from "./machine-identity.ts";
import { createOperatorKey, deleteOperatorKey, listOperatorKeys, CreateOperatorKeyInput } from "./operator-keys.ts";
import type { CredentialStore } from "../../security/store.ts";
import { isMasterRole } from "../../../shared/enums.ts";

export interface ClustersApiDeps {
  db: Db;
  storeMode: () => StoreMode; // already mapped in wire so inventory stays decoupled from security
  logger: Logger;
}

export interface ServerApiDeps {
  db: Db;
  /** Read only, and for ONE question: which servers this manager already holds a credential for
   *  (`serverCredFlags`), plus the purge a delete performs. Nothing on this surface seals one — a
   *  credential is placed on a machine by a run, never by a route. */
  creds: CredentialStore;
  actor: () => string;
}

/**
 * The single-screen clusters snapshot. needsYou = runs awaiting approval, running =
 * live runs — the two action queues the UI leads with. sources report per-collector wiring;
 * only inventory (the DB) is wired, the rest are honestly "unwired".
 *
 * `servers` = the MANAGED servers only (the slaves). The master — this manager itself —
 * is not something it manages, so it must never inflate the managed count (UI mirrors reality
 * 1:1); it rides the dedicated `master` field instead.
 */
export function buildClustersView(db: Db, storeMode: StoreMode): ClustersView {
  const runs = listRuns(db);
  const needsYou = runs.filter((r) => r.status === "planned");
  const inventory = listServers(db, undefined);
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
  app.get("/api/clusters", (c) => c.json(buildClustersView(deps.db, deps.storeMode())));
  // The whole lock table, and the ONE read that has no browser caller: nothing in web/src lists locks
  // yet. It is served anyway because a refused approve answers 409 with the single claim that
  // collided (resource, key, holderRunId) and nothing else, so neither the operator nor a reader of
  // this code can see what ELSE is held or who holds it — which is the question behind every "why can
  // no run start" and behind deciding whether a claim needs to be platform-wide or per cluster.
  app.get("/api/locks", (c) => c.json(listLocks(deps.db)));
}

/** Server inventory routes: WHERE a machine is, and nothing that touches one. Adding a server records
 *  an address, a user and a port; every act that reaches the machine — installing this manager's key
 *  included — is a run, planned through POST /api/runs, because it has a plan, an approval and a log.
 *  All behind the auth chokepoint + CSRF. */
export function registerServerRoutes(app: Hono<AppEnv>, deps: ServerApiDeps): void {
  const { db, creds } = deps;

  app.get("/api/servers", async (c) =>
    c.json({ servers: listServers(db, await serverCredFlags(creds)) }),
  );

  app.post("/api/servers", async (c) => {
    const input = CreateServerInput.parse(await c.req.json().catch(() => ({})));
    return c.json({ server: createServer(db, deps.actor(), input) }, 201);
  });

  app.delete("/api/servers/:id", async (c) => {
    await deleteServer(db, creds, deps.actor(), c.req.param("id"));
    return c.json({ ok: true });
  });

  // The one statement a person makes about a machine that no reading can replace: this machine was
  // rebuilt, and here is the host key it presents now. Every run refuses a machine whose host key is
  // not the one recorded for it, and refuses it before a credential is offered — which is right, and
  // which leaves an operator who reinstalled the box with a machine nothing can reach. This route is
  // how they say so; it writes the two numbers this manager records about the machine's operating
  // system (machine-identity.ts) and reaches nothing. The machine still has to present the stated
  // key on the next run.
  app.post("/api/servers/:id/machine-identity", async (c) => {
    const input = RestateMachineIdentityInput.parse(await c.req.json().catch(() => ({})));
    restateMachineIdentity(db, deps.actor(), c.req.param("id"), input);
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

}
