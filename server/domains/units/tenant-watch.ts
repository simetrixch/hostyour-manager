// The tenant set-watch predicate + its failure message — shared by create-tenant.run.ts and
// add-app.run.ts (extracted here so neither run file carries the other's copy, and to keep
// create-tenant under the 400-line budget).
//
// The pass rule is completeness + Synced/Healthy, WITHOUT a syncRevision check: the deployed tenant
// appsets track a catalog BRANCH (not a per-tenant pin), the pointer write itself advances that
// branch past chartsRef, and per-app Applications are MULTI-SOURCE (status.sync.revision unset) — so a
// revision-equality gate would never converge. The chart gates run at PLAN time against chartsRef,
// not at the deploy watch.
import type { ArgoAppStatus, ArgoAppStatusMap } from "../../adapters/kube/port.ts";

/** Set-watch pass predicate: EVERY expected Application present, Synced, Healthy (an absent name reads
 *  Missing, so it fails). */
export function syncedAt(expected: readonly string[]): (byName: ArgoAppStatusMap) => boolean {
  return (byName) => expected.every((name) => isSynced(byName.get(name)));
}

function isSynced(s: ArgoAppStatus | undefined): boolean {
  return !!s && s.sync === "Synced" && s.health === "Healthy";
}

/** A precise failure message for a set-watch timeout: which members are lagging and why. */
export function describeUnsynced(expected: readonly string[], byName: ArgoAppStatusMap): string {
  const lagging = expected
    .filter((name) => !isSynced(byName.get(name)))
    .map((name) => {
      const s = byName.get(name);
      return s ? `${name}(sync=${s.sync},health=${s.health})` : `${name}(absent)`;
    });
  return `the tenant fan-out did not fully reach Synced/Healthy — ${lagging.length} of ${expected.length} Application(s) lagging: ${lagging.join(", ")}`;
}
