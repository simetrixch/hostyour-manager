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
  return !!s && !s.refreshRequested && s.sync === "Synced" && s.health === "Healthy";
}

/** A precise failure message for a set-watch timeout: which Applications are not settled and why. */
export function describeUnsynced(expected: readonly string[], byName: ArgoAppStatusMap): string {
  const lagging = expected
    .filter((name) => !isSynced(byName.get(name)))
    .map((name) => {
      const s = byName.get(name);
      return s ? `${name}(sync=${s.sync},health=${s.health}${s.refreshRequested ? ",refresh=pending" : ""})` : `${name}(absent)`;
    });
  return `${lagging.length} of ${expected.length} Application(s) are not Synced/Healthy: ${lagging.join(", ")}`;
}

/** The two switches the Manager flips on a unit's registration and its charts render. */
export type UnitSwitch = "suspended" | "quiesced";

/** Whether the values of one switch, read off an Application's sources, say `on`: at least one source,
 *  and every value at `on`, where an absent value reads as off. No source to read proves nothing. */
export function switchValuesSay(values: readonly unknown[], on: boolean): boolean {
  return values.length > 0 && values.every((v) => (on ? v === true : v === false || v === undefined));
}

/** The `tenant.<name>` values a member Application renders on its sources from the deploy repository. */
function tenantSwitchValues(s: ArgoAppStatus | undefined, deployRepoUrl: string, name: UnitSwitch): unknown[] {
  return (s?.syncSources ?? []).filter((src) => src.repoURL === deployRepoUrl && src.path).map((src) => (src.valuesObject?.["tenant"] as Record<string, unknown> | undefined)?.[name]);
}

/** Set-watch pass predicate for a tenant's fan-out after a flip of `tenant.<name>`: every member is
 *  settled (syncedAt) and renders the switch at `on` on every source of the deploy repository. The
 *  render from before the flip is settled too, so the value is what tells the two apart. */
export function tenantRendersSwitch(expected: readonly string[], deployRepoUrl: string, name: UnitSwitch, on: boolean): (byName: ArgoAppStatusMap) => boolean {
  return (byName) => syncedAt(expected)(byName) && expected.every((n) => switchValuesSay(tenantSwitchValues(byName.get(n), deployRepoUrl, name), on));
}

/** The failure message of a tenant switch watch: what has not settled, and which members have not flipped. */
export function describeTenantSwitch(expected: readonly string[], deployRepoUrl: string, name: UnitSwitch, on: boolean, byName: ArgoAppStatusMap): string {
  const unflipped = expected
    .filter((n) => !switchValuesSay(tenantSwitchValues(byName.get(n), deployRepoUrl, name), on))
    .map((n) => `${n}(${name}=${tenantSwitchValues(byName.get(n), deployRepoUrl, name).map(String).join(",") || "no source of the deploy repository"})`);
  return [
    ...(syncedAt(expected)(byName) ? [] : [describeUnsynced(expected, byName)]),
    ...(unflipped.length > 0 ? [`${unflipped.length} of ${expected.length} member(s) do not render ${name}=${on}: ${unflipped.join(", ")}`] : []),
  ].join("; ");
}

