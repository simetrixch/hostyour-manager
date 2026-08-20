import { useEffect, useState, type ReactNode } from "react";
import type { ClusterOrphanConsumerView, ConsumerLiveProbeView, DetectedConsumerView, DetectedScanView } from "../../../shared/api-types.ts";
import { probeConsumerLive } from "../api.ts";
import { LiveReconFacts } from "./LiveReconFacts.tsx";

/** What a purge needs to aim: the G1 identity, which a detected consumer and a cluster orphan both
 *  carry. Typed as the intersection rather than as either view, because the two reach the SAME dialog
 *  and neither of the other fields would be read there. */
export interface PurgeTarget {
  name: string;
  clusterId: string;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The LIVE truth of ONE detected consumer, probed lazily per row (GET /api/consumers/live — the
 *  name-keyed probe; a detected consumer has no appId). This is the OTHER side of the two-sided card:
 *  the row above it shows what the POINTER says, this shows what actually RUNS, rendered through the
 *  SAME shared fact rows the Consumers card uses (LiveReconFacts → ReconDrift) — so only `converged`
 *  is ever green, and a pointer with no live app reads "not deployed", never a false pass. Fired only
 *  AFTER an explicit scan put this row on screen (the scan button gates everything — nothing here runs
 *  on page load). */
function DetectedLive({ d }: { d: DetectedConsumerView }) {
  const [live, setLive] = useState<ConsumerLiveProbeView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    probeConsumerLive({ clusterId: d.clusterId, name: d.name, stage: d.stage, repoURL: d.pointer.repoURL })
      .then((l) => {
        if (alive) setLive(l);
      })
      .catch((e: unknown) => {
        if (alive) setError(msg(e));
      });
    return () => {
      alive = false;
    };
  }, [d.clusterId, d.name, d.stage, d.pointer.repoURL]);

  if (error) return <div className="recon recon--muted">Live check failed: {error} — the pointer claim above is NOT confirmed.</div>;
  if (!live)
    return (
      <div className="recon recon--muted">
        <span className="spinner" aria-hidden="true" /> Checking the cluster…
      </div>
    );
  if (live.reason === "onboarding-not-configured")
    return <div className="recon recon--muted">Live checks unavailable — onboarding is not configured on this controller.</div>;

  return <LiveReconFacts live={live} />;
}

/** The detected consumers the scan could READ, each as a two-sided card: the POINTER's claim (labeled
 *  as exactly that) above the LIVE probe, with the two actions a detected consumer allows — ADOPT
 *  (reconstruct the inventory row, the normal remedy) and PURGE (remove the whole footprint, for a
 *  leftover that should not exist). Every row here carries a resolved clusterId by construction — the
 *  consumer scan iterates the registered active clusters rows — so unlike the tenant orphan panel
 *  there is no unaimable row to withhold a button from. */
function DetectedRows({ detected, onAdopt, onPurge }: {
  detected: DetectedConsumerView[];
  onAdopt: (d: DetectedConsumerView) => void;
  onPurge: (t: PurgeTarget) => void;
}) {
  return (
    <ul className="cards">
      {detected.map((d) => (
        <li key={`${d.clusterId}/${d.stage}/${d.name}`} className="card servercard">
          <div className="card__head">
            <strong className="servercard__name">{d.name}</strong>
            <span className="badge badge--degraded">detected</span>
          </div>
          <div className="servercard__target">
            {d.domain} · {d.stage} · registered on {d.pointer.cluster}
          </div>
          {/* The REGISTRATION side, labeled as its CLAIM: the bulk scan probed nothing live, so none of
              this may read as "running" — the live truth is the probe underneath. */}
          <div className="servercard__chips">
            <span className="chip">registration says: {d.pointer.suspended ? "suspended" : "running"}</span>
            <span className="chip">{d.pointer.repoURL.replace(/^https:\/\//, "").replace(/\.git$/, "")}</span>
            <span className="chip">{d.pointer.chartPath}</span>
            {d.pointer.owner && <span className="chip">owner {d.pointer.owner}</span>}
            {d.pointer.quiesced && <span className="chip">quiesced</span>}
          </div>

          <DetectedLive d={d} />

          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={() => onAdopt(d)}>
              Adopt…
            </button>
            <button type="button" className="btn btn--danger" onClick={() => onPurge(d)}>
              Purge…
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The CLUSTER-ORPHAN rows: consumer namespaces standing on a cluster that NEITHER book accounts for.
 *  Every field is a live cluster read — there is no registration to claim anything — so unlike the
 *  detected rows above there is no "registration says" chip and no separate live probe underneath: the
 *  row IS the live truth.
 *
 *  Only PURGE is offered, and the row says why. Adopt reconstructs the inventory row FROM the
 *  registration, and a cluster orphan has none, so an adopt button here would be a button that cannot
 *  work — the operator's route back is to write the registration, which is not something this panel
 *  can do for them. */
function ClusterOrphanRows({ orphans, onPurge }: {
  orphans: ClusterOrphanConsumerView[];
  onPurge: (t: PurgeTarget) => void;
}) {
  return (
    <ul className="cards">
      {orphans.map((o) => (
        <li key={`${o.clusterId}/${o.name}`} className="card servercard">
          <div className="card__head">
            <strong className="servercard__name">{o.name}</strong>
            <span className={o.running > 0 ? "badge badge--failed" : "badge badge--degraded"}>{o.running > 0 ? "serving, untracked" : "leftover namespace"}</span>
          </div>
          <div className="servercard__target">
            {o.domain} · {o.stage} · namespace {o.name}
          </div>
          {/* The live counts, and nothing that could read as a claim: no file said any of this. */}
          <div className="servercard__chips">
            <span className="chip">
              {o.running} of {o.workloads} workload(s) ready
            </span>
            <span className="chip">{o.externalSecretsReady ? "secrets synced" : "secrets not synced"}</span>
            <span className="chip">no registration</span>
            <span className="chip">no inventory row</span>
          </div>
          <div className="recon recon--muted">
            {o.running > 0
              ? "This namespace is SERVING and the platform does not know it runs. Nothing on the Consumers list reaches it, and no release, suspend or offboard can address it."
              : "This namespace holds nothing that is ready — the remains of a removal that never finished reaping it."}{" "}
            Adopt is not offered: it rebuilds the inventory row from the registration, and there is none. To keep this consumer, write its registration and scan again; to remove it, purge.
          </div>
          <div className="actions">
            <button type="button" className="btn btn--danger" onClick={() => onPurge({ name: o.name, clusterId: o.clusterId })}>
              Purge…
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** What the DETECTED scan found — consumers the GitOps pointers know and the
 *  inventory does not, so they appear nowhere under Consumers and no row-keyed run kind can reach them.
 *  The consumer twin of TenantOrphanPanel, obeying the same honesty rules: the page owns the scan
 *  STATE and the adopt/purge hand-offs, this owns how a fail-soft scan result is told honestly.
 *
 *  Every branch says which of the three failures it is — the request failed, the install branches
 *  could not be read (nothing was checked), or consumer onboarding is not wired at all — instead of
 *  letting an empty list read as "none detected". `skipped` carries that same rule PER POINTER: a
 *  registrations/<name>/<stage>.yaml nobody could parse may BE a detected consumer, so it is
 *  listed with its reason rather than dropped, and its presence downgrades the all-clear sentence.
 *
 *  The scan has a SECOND half and this panel renders it as its own group: the cluster orphans — consumer
 *  namespaces neither book accounts for. They are kept visually apart from the detected rows because
 *  their evidence is of a different kind (a live cluster read, not a file's claim) and their remedy is
 *  narrower (purge only — adopt has no registration to rebuild a row from). `unscanned` is that half's
 *  `skipped`: a cluster nobody could read may be holding orphans, so it is named rather than passed
 *  over, and its presence downgrades the all-clear the same way. */
export function DetectedConsumerPanel(props: {
  scanning: boolean;
  /** A failed REQUEST (the route's own fail-soft failure arrives inside `scan.error` instead). */
  scanError: string | null;
  scan: DetectedScanView | null;
  onAdopt: (d: DetectedConsumerView) => void;
  onPurge: (t: PurgeTarget) => void;
}): ReactNode {
  const { scanning, scanError, scan } = props;
  // The count on the header is what the operator has to ACT on: both kinds of untracked consumer, one
  // number. Splitting it would let a page with orphans and no detected rows read as a clean zero.
  const actionable = scan === null ? 0 : scan.detected.length + scan.clusterOrphans.length;
  return (
    <section className="panel">
      <header className="panel__head">
        <h3 className="panel__title">Detected consumers</h3>
        {scan !== null && scan.error === undefined && scan.reason === undefined && <span className="panel__count">{actionable}</span>}
      </header>
      {scanning ? (
        <div className="loading">
          <span className="spinner" aria-hidden="true" />
          Scanning the GitOps consumer pointers on every active cluster…
        </div>
      ) : scanError !== null ? (
        <p role="alert" className="alert alert--danger">
          The scan request failed: {scanError}
        </p>
      ) : scan === null ? null : scan.reason === "onboarding-not-configured" ? (
        <p className="alert alert--warn">Consumer onboarding is not configured on this controller — there are no consumer pointers to scan.</p>
      ) : (
        <>
          {/* The registration half failed. It is an alert rather than a branch that hides everything
              else, because the CLUSTER half may still have found orphans and they must not disappear
              behind the other half's failure. */}
          {scan.error !== undefined && (
            <p role="alert" className="alert alert--danger">
              The registration side of the scan could not be read: {scan.error}. No consumer registration was checked — this is not &ldquo;none
              detected&rdquo;.
            </p>
          )}
          {scan.detected.length === 0 ? (
            <div className="empty">
              {/* The all-clear sentence is only TRUE when every pointer could be read. With skipped
                  pointers it would claim the controller accounted for consumers it never even parsed. */}
              <p>
                {scan.error !== undefined
                  ? "No consumer registration could be checked — see above."
                  : scan.skipped.length === 0
                    ? "No detected consumers — every deployed consumer pointer has a matching inventory row."
                    : "Every pointer that could be read has a matching inventory row — but the pointers below could not be read, so this is not an all-clear."}
              </p>
            </div>
          ) : (
            <DetectedRows detected={scan.detected} onAdopt={props.onAdopt} onPurge={props.onPurge} />
          )}
          {/* Pointers the scan could not parse. Listed rather than dropped: one of them may BE an
              untracked consumer, and only the operator can go look at the file the reason names. */}
          {scan.skipped.length > 0 && (
            <>
              <p role="alert" className="alert alert--warn">
                {scan.skipped.length} consumer registration(s) could not be read, so they are neither confirmed nor ruled out as
                untracked consumers. Fix the file in GitOps (the reason below names it), then scan again.
              </p>
              <ul className="rows">
                {scan.skipped.map((s) => (
                  <li key={`skipped/${s.stage}/${s.name}`}>
                    <div className="row">
                      <span className="badge badge--degraded">unreadable</span>
                      <span className="row__title mono">{s.name}</span>
                      <span className="row__meta">
                        {s.stage} · {s.reason}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* THE OTHER HALF. Its own heading, because a reader has to know that nothing below rests on
              a file: these are namespaces the cluster itself reported, and the registration diff above
              structurally cannot see them. */}
          <header className="panel__head">
            <h4 className="panel__title">Untracked consumer namespaces on the clusters</h4>
            <span className="panel__count">{scan.clusterOrphans.length}</span>
          </header>
          {scan.clusterOrphans.length === 0 ? (
            <div className="empty">
              <p>
                {scan.unscanned.length === 0
                  ? "None — every consumer namespace on every active cluster is accounted for by a registration or an inventory row."
                  : "Every cluster that could be read is accounted for — but the clusters below could not be read, so this is not an all-clear."}
              </p>
            </div>
          ) : (
            <ClusterOrphanRows orphans={scan.clusterOrphans} onPurge={props.onPurge} />
          )}
          {/* Clusters the scan could not read. The same rule `skipped` obeys, one level up: an
              unreachable cluster may be holding a serving consumer nobody can see, and silence would
              read as "none there" — the very failure this scan exists to end. */}
          {scan.unscanned.length > 0 && (
            <>
              <p role="alert" className="alert alert--warn">
                {scan.unscanned.length} cluster(s) could not be scanned, so any untracked consumer namespace on them is neither
                confirmed nor ruled out. Fix the cluster&rsquo;s reachability (the reason below names what failed), then scan again.
              </p>
              <ul className="rows">
                {scan.unscanned.map((u) => (
                  <li key={`unscanned/${u.clusterId}`}>
                    <div className="row">
                      <span className="badge badge--degraded">unreachable</span>
                      <span className="row__title mono">{u.domain}</span>
                      <span className="row__meta">
                        {u.stage} · {u.reason}
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
