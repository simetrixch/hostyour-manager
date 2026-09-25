// Whether a set of ArgoCD Applications has settled, read off the kube port's ArgoAppStatusMap, and
// the failure message a set-watch throws when it has not.
//
// The pass rule is completeness + Synced/Healthy, WITHOUT a syncRevision check: an Application set
// that tracks a BRANCH (not a pin) is advanced past the watched commit by the very write that set it
// off, and a MULTI-SOURCE Application carries no status.sync.revision — so a revision-equality gate
// would never converge.
import type { ArgoAppStatus, ArgoAppStatusMap } from "#core/server/adapters/kube/port.ts";

/** Set-watch pass predicate: EVERY expected Application present, Synced, Healthy (an absent name reads
 *  Missing, so it fails). */
export function syncedAt(expected: readonly string[]): (byName: ArgoAppStatusMap) => boolean {
  return (byName) => expected.every((name) => isSynced(byName.get(name)));
}

function isSynced(s: ArgoAppStatus | undefined): boolean {
  return !!s && s.sync === "Synced" && s.health === "Healthy";
}

/** A precise failure message for a set-watch timeout: which Applications are not settled and why. */
export function describeUnsynced(expected: readonly string[], byName: ArgoAppStatusMap): string {
  const lagging = expected
    .filter((name) => !isSynced(byName.get(name)))
    .map((name) => {
      const s = byName.get(name);
      return s ? `${name}(sync=${s.sync},health=${s.health})` : `${name}(absent)`;
    });
  return `${lagging.length} of ${expected.length} Application(s) are not Synced/Healthy: ${lagging.join(", ")}`;
}
