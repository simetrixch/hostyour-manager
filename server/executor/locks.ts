import { eq, and, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runLocks, runs } from "../db/schema/runs.ts";
import { errResourceBusy } from "../kernel/errors.ts";
import { newId } from "../kernel/ids.ts";
import { deletion } from "../db/schema/stamps.ts";
import type { LockClaim, RunTargetRef } from "./types.ts";
import type { LockView } from "../../shared/api-types.ts";

// The run_locks manager. The mutex is the unique index over the locks not released; acquisition is
// all-or-nothing inside one transaction, deadlock-free by construction (no mid-run
// acquisition). A release marks the row deleted, so it stays and names who released it. Held from the start through running, and on through failed or cancelled in the
// middle, until the run succeeds, finishes its cleanup, is aborted or is deleted.

export function deriveServerLocks(targets: RunTargetRef[]): LockClaim[] {
  return targets.filter((t) => t.ownsHost).map((t): LockClaim => ({ resource: "server", key: t.serverId }));
}

export function isGlobalClaim(c: { resource: string; key: string }): boolean {
  return (c.resource === "manager" && c.key === "self") || (c.resource === "all" && c.key === "*");
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

/** A claim that is taken, by a run holding it or by a queued run waiting for it ahead in line. */
export interface TakenClaim { resource: string; key: string; runId: string }

/** Every taken claim that `claims` collides with. A global claim (manager:self / all:*) collides with
 *  everything, in both directions. */
export function lockConflicts(taken: readonly TakenClaim[], claims: readonly LockClaim[]): TakenClaim[] {
  if (claims.length === 0) return [];
  const global = taken.filter((t) => isGlobalClaim(t));
  if (global.length > 0) return global;
  if (claims.some(isGlobalClaim)) return [...taken];
  return taken.filter((t) => claims.some((c) => c.resource === t.resource && c.key === t.key));
}

/**
 * Acquire every claim the run does not hold yet, atomically. A run that failed or was cancelled in the
 * middle still holds its claims when it is retried, skipped or aborted, and takes only what it lost.
 * Any conflict throws RESOURCE_BUSY and inserts nothing (all-or-nothing).
 *
 * The claims go in as the caller states them, with no rewriting on the way: there is ONE Vault for the
 * platform and it sits on the master, so a run that writes Vault claims master-vault:m outright and
 * there is no per-cluster Vault claim left to fold into it.
 */
export function acquireLocks(db: Db, runId: string, rawClaims: LockClaim[]): void {
  db.transaction((tx) => {
    const all = tx.select().from(runLocks).where(isNull(runLocks.deleted)).all();
    const missing = dedupeClaims(rawClaims).filter((c) => !all.some((l) => l.runId === runId && l.resource === c.resource && l.key === c.key));
    const held = lockConflicts(all.filter((l) => l.runId !== runId), missing)[0];
    if (held) throw errResourceBusy("Resource busy", { resource: held.resource, key: held.key, holderRunId: held.runId });
    for (const c of missing) insertLock(tx, c, runId);
  });
}

/** Hold `claim` for `runId`. The unique index over the locks not released refuses a second holder. */
export function insertLock(db: Db, claim: LockClaim, runId: string): void {
  db.insert(runLocks).values({ id: newId("lock"), resource: claim.resource, key: claim.key, runId }).run();
}

export function releaseLocks(db: Db, runId: string): void {
  db.update(runLocks).set(deletion()).where(and(eq(runLocks.runId, runId), isNull(runLocks.deleted))).run();
}

export function listLocks(db: Db): LockView[] {
  return db
    .select()
    .from(runLocks)
    .where(isNull(runLocks.deleted))
    .all()
    .map((r) => ({ resource: r.resource, key: r.key, runId: r.runId, creation: r.creation.getTime() }));
}

/**
 * Drop orphaned locks — only approved/running/failed/cancelled runs may hold them.
 * Backs the locks.rebuilt self-check: repairs the (astronomically rare) crash window
 * between lock acquisition and the status→approved write.
 */
export function reconcileLocks(db: Db): void {
  const held = new Set(
    db
      .select({ id: runs.id })
      .from(runs)
      .where(inArray(runs.status, ["approved", "running", "failed", "cancelled"]))
      .all()
      .map((r) => r.id),
  );
  for (const l of db.select().from(runLocks).where(isNull(runLocks.deleted)).all()) {
    if (!held.has(l.runId)) db.update(runLocks).set(deletion()).where(eq(runLocks.id, l.id)).run();
  }
}
