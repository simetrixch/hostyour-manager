import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runLocks, runs } from "../db/schema/runs.ts";
import { errResourceBusy } from "../kernel/errors.ts";
import type { LockClaim, RunTargetRef } from "./types.ts";
import type { LockView } from "../../shared/api-types.ts";

// The run_locks manager. The mutex IS the primary key; acquisition is
// all-or-nothing inside one transaction, deadlock-free by construction (no mid-run
// acquisition). Held through approved/running/failed; released in the terminal tx.

export function deriveServerLocks(targets: RunTargetRef[]): LockClaim[] {
  return targets.filter((t) => t.ownsHost).map((t): LockClaim => ({ resource: "server", key: t.serverId }));
}

export function isGlobalClaim(c: LockClaim): boolean {
  return (c.resource === "controller" && c.key === "self") || (c.resource === "all" && c.key === "*");
}

export function dedupeClaims(claims: LockClaim[]): LockClaim[] {
  const seen = new Set<string>();
  const out: LockClaim[] = [];
  for (const c of claims) {
    const k = `${c.resource}:${c.key}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/**
 * Acquire every claim atomically. Global claims (controller:self / all:*) require the
 * table empty; any conflict throws RESOURCE_BUSY and inserts nothing (all-or-nothing).
 *
 * The claims go in as the caller states them, with no rewriting on the way: there is ONE Vault for the
 * platform and it sits on the master, so a run that writes Vault claims master-vault:m outright and
 * there is no per-cluster Vault claim left to fold into it.
 */
export function acquireLocks(db: Db, runId: string, rawClaims: LockClaim[]): void {
  const claims = dedupeClaims(rawClaims);
  if (claims.length === 0) return;
  db.transaction((tx) => {
    const existing = tx.select().from(runLocks).all();
    const heldGlobal = existing.find((r) => isGlobalClaim({ resource: r.resource, key: r.key }));
    if (heldGlobal) throw errResourceBusy({ resource: heldGlobal.resource, key: heldGlobal.key, holderRunId: heldGlobal.runId });
    if (claims.some(isGlobalClaim) && existing.length > 0) {
      const h = existing[0];
      if (h) throw errResourceBusy({ resource: h.resource, key: h.key, holderRunId: h.runId });
    }
    for (const c of claims) {
      const held = existing.find((r) => r.resource === c.resource && r.key === c.key);
      if (held) throw errResourceBusy({ resource: c.resource, key: c.key, holderRunId: held.runId });
    }
    for (const c of claims) tx.insert(runLocks).values({ resource: c.resource, key: c.key, runId }).run();
  });
}

export function releaseLocks(db: Db, runId: string): void {
  db.delete(runLocks).where(eq(runLocks.runId, runId)).run();
}

export function listLocks(db: Db): LockView[] {
  return db
    .select()
    .from(runLocks)
    .all()
    .map((r) => ({ resource: r.resource, key: r.key, runId: r.runId, acquiredAt: r.acquiredAt.getTime() }));
}

/**
 * Drop orphaned locks — only approved/running/failed runs may hold them.
 * Backs the locks.rebuilt self-check: repairs the (astronomically rare) crash window
 * between lock acquisition and the status→approved write.
 */
export function reconcileLocks(db: Db): void {
  const held = new Set(
    db
      .select({ id: runs.id })
      .from(runs)
      .where(inArray(runs.status, ["approved", "running", "failed"]))
      .all()
      .map((r) => r.id),
  );
  for (const l of db.select().from(runLocks).all()) {
    if (!held.has(l.runId)) db.delete(runLocks).where(and(eq(runLocks.resource, l.resource), eq(runLocks.key, l.key))).run();
  }
}
