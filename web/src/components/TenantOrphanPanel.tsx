import type { ReactNode } from "react";
import type { OrphanScanView, OrphanTenantView, PurgeTenantTarget } from "../../../shared/api-types.ts";

/** The orphans the scan could READ, each with the one action it allows. A tenant whose slave name
 *  resolves to no registered cluster keeps its row but gets NO purge button: a purge is keyed on a
 *  clusterId, so there is nothing to aim — and hiding the row would hide the very leftover the operator
 *  scanned for. Its own component so the panel below stays readable beside the skipped-pointer list. */
function OrphanRows({ orphans, onPurge }: { orphans: OrphanTenantView[]; onPurge: (t: PurgeTenantTarget) => void }) {
  return (
    <ul className="rows">
      {orphans.map((o) => {
        // Bound to a local so the null-check narrows inside the click handler (a property narrowing
        // does not survive into a nested closure).
        const clusterId = o.clusterId;
        return (
          <li key={`${o.stage}/${o.guid}`}>
            <div className="row">
              <span className="badge badge--degraded">orphan</span>
              <span className="row__title">{o.subdomain}</span>
              <span className="row__meta">
                {o.guid} · {o.stage} · {o.cluster}
              </span>
              <span className="row__end">
                {clusterId === null ? (
                  <span
                    className="chip chip--warn"
                    title={`No registered cluster is named "${o.cluster}", so this controller cannot aim a purge at it. Register that slave first.`}
                  >
                    cluster &ldquo;{o.cluster}&rdquo; not registered
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => onPurge({ guid: o.guid, subdomain: o.subdomain, stage: o.stage, clusterId })}
                  >
                    Purge…
                  </button>
                )}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** What the ORPHAN SCAN found — tenants the GitOps pointers know and the inventory
 *  does not, so they are on no list of the Tenants page and no row-keyed verb can reach them. Its own
 *  component, like FailedCreateTenantCallout is on the run screen: the page owns the scan STATE and the
 *  purge hand-off, this owns how a fail-soft scan result is told honestly.
 *
 *  And "honestly" is the whole of it. The route answers a failed scan with 200 + an EMPTY list plus the
 *  failure text, so every branch here says which of the three it is — the request failed, the repo could
 *  not be read (nothing was checked), or tenant onboarding is not wired at all — instead of letting an
 *  empty list read as "no orphans found". `skipped` carries that same rule PER REGISTRATION: a registrations/
 *  <guid>/ nobody could parse may BE an orphan, so it is listed with its reason rather than dropped, and
 *  its presence downgrades the all-clear sentence above it. */
export function TenantOrphanPanel(props: {
  scanning: boolean;
  /** A failed REQUEST (the route's own fail-soft failure arrives inside `scan.error` instead). */
  scanError: string | null;
  scan: OrphanScanView | null;
  onPurge: (t: PurgeTenantTarget) => void;
}): ReactNode {
  const { scanning, scanError, scan } = props;
  return (
    <section className="panel">
      <header className="panel__head">
        <h3 className="panel__title">Orphaned tenants</h3>
        {scan !== null && scan.error === undefined && scan.reason === undefined && <span className="panel__count">{scan.orphans.length}</span>}
      </header>
      {scanning ? (
        <div className="loading">
          <span className="spinner" aria-hidden="true" />
          Scanning the GitOps tenant pointers on every stage…
        </div>
      ) : scanError !== null ? (
        <p role="alert" className="alert alert--danger">
          The scan request failed: {scanError}
        </p>
      ) : scan === null ? null : scan.error !== undefined ? (
        // The route is fail-soft, so a failed scan still answers 200 with an empty list — saying
        // "no orphans" here would be the exact opposite of the truth. Say what actually happened.
        <p role="alert" className="alert alert--danger">
          The scan could not read the GitOps repo: {scan.error}. Nothing was checked — this is not &ldquo;no orphans found&rdquo;.
        </p>
      ) : scan.reason === "onboarding-not-configured" ? (
        <p className="alert alert--warn">Tenant onboarding is not configured on this controller — there are no tenant pointers to scan.</p>
      ) : (
        <>
          {scan.orphans.length === 0 ? (
            <div className="empty">
              {/* The all-clear sentence is only TRUE when every pointer could be read. With skipped
                  pointers it would claim the controller accounted for tenants it never even parsed. */}
              <p>
                {scan.skipped.length === 0
                  ? "No orphaned tenants — every deployed tenant pointer has a matching inventory row."
                  : "Every pointer that could be read has a matching inventory row — but the pointers below could not be read, so this is not an all-clear."}
              </p>
            </div>
          ) : (
            <OrphanRows orphans={scan.orphans} onPurge={props.onPurge} />
          )}
          {/* Pointers the scan could not parse. Listed rather than dropped: one of them may BE an
              orphan, and only the operator can go look at the file the reason names. */}
          {scan.skipped.length > 0 && (
            <>
              <p role="alert" className="alert alert--warn">
                {scan.skipped.length} tenant pointer(s) could not be read, so they are neither confirmed nor ruled out as orphans. Fix the
                file in catalog (or purge the tenant once it reads again) — a purge cannot be aimed at a pointer whose target cluster is
                unknown.
              </p>
              <ul className="rows">
                {scan.skipped.map((s) => (
                  <li key={`skipped/${s.stage}/${s.guid}`}>
                    <div className="row">
                      <span className="badge badge--degraded">unreadable</span>
                      <span className="row__title mono">{s.guid}</span>
                      <span className="row__meta">
                        {s.stage} · {s.reason}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
