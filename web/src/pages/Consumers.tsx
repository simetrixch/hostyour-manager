import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { DetectedConsumerView, DetectedScanView, RunView } from "../../../shared/api-types.ts";
import {
  listConsumers, getConsumerLive, offboardConsumer, purgeConsumer,
  scanDetectedConsumers, adoptConsumer, backupConsumer, restoreConsumer, migrateConsumer, listRuns, setConsumerSize,
  type ConsumerView, type PurgeInput,
} from "../api.ts";
import { CONSUMER_RUN_KINDS } from "../runKinds.ts";
import { relocationRun, relocationLine } from "../relocationBand.ts";
import { SectionRuns } from "../components/SectionRuns.tsx";
import { TypeToConfirm } from "../components/TypeToConfirm.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { ConsumerLifecycleDialog, type LifecycleAction } from "../components/ConsumerLifecycleDialog.tsx";
import { SetSizeDialog } from "../components/SetSizeDialog.tsx";
import { PurgeOrphanDialog } from "../components/PurgeOrphanDialog.tsx";
import { DetectedConsumerPanel } from "../components/DetectedConsumerPanel.tsx";
import { LiveReconFacts } from "../components/LiveReconFacts.tsx";
import { OffboardedConsumers, ConsumerBackupDialog, ConsumerRelocationDialog } from "../components/ConsumerRelocation.tsx";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The LIVE reconciliation of ONE consumer, loaded lazily per row (a slow/unreachable slave spins
 *  only its own card). The fact rows themselves — cluster smoke, ArgoCD status, drift verdict — are
 *  the ONE shared renderer (LiveReconFacts): what the GitOps pointer pins vs what the cluster runs. */
function ConsumerLive({ appId }: { appId: string }) {
  const [live, setLive] = useState<Awaited<ReturnType<typeof getConsumerLive>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getConsumerLive(appId)
      .then((l) => {
        if (alive) setLive(l);
      })
      .catch((e: unknown) => {
        if (alive) setError(msg(e));
      });
    return () => {
      alive = false;
    };
  }, [appId]);

  if (error) return <div className="recon recon--muted">Live check failed: {error}</div>;
  if (!live)
    return (
      <div className="recon recon--muted">
        <span className="spinner" aria-hidden="true" /> Checking the cluster…
      </div>
    );
  if (live.reason === "onboarding-not-configured")
    return <div className="recon recon--muted">Live checks unavailable — onboarding is not configured on this controller.</div>;

  return (
    <>
      {/* The unit's ONE public host, composed server-side from the target cluster's own unitApex.
          Absent when that chain could not be read — no link beats a link to a name nothing serves. */}
      {live.unitHost && (
        <div className="servercard__chips">
          <a className="chip chip--link" href={`https://${live.unitHost}`} target="_blank" rel="noreferrer">
            {live.unitHost} ↗
          </a>
        </div>
      )}
      <LiveReconFacts live={live} />
    </>
  );
}

/** The onboarded consumer apps as a two-tab section. LEFT ("Reconciliation") is the
 *  combined view: each SQL row (what the Controller BELIEVES) beside the live cluster + ArgoCD facts
 *  (what actually RUNS), drift highlighted. RIGHT ("Runs") is this section's runs — the ONE shared
 *  runs component filtered to consumer kinds. Every lifecycle action plans a Run and hands off to the
 *  Run screen; a settled row is kept even after offboard. */
export function Consumers() {
  const nav = useNavigate();
  const [rows, setRows] = useState<ConsumerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"live" | "runs">("live");
  const [confirmTarget, setConfirmTarget] = useState<ConsumerView | null>(null);
  const [lifecycle, setLifecycle] = useState<{ c: ConsumerView; action: LifecycleAction } | null>(null);
  // The size dialog's target (null = closed). Its own state and not part of `lifecycle`, because it
  // asks a QUESTION (which size) where those only confirm.
  const [sizeFor, setSizeFor] = useState<ConsumerView | null>(null);
  // The relocation dialogs: "Back up" is a plain confirm (no target — the folder is named
  // after the unit); "Move…"/"Restore…" pick a target cluster. Confirming only PLANS the run.
  const [backupFor, setBackupFor] = useState<ConsumerView | null>(null);
  const [relocFor, setRelocFor] = useState<{ c: ConsumerView; verb: "move" | "restore" } | null>(null);
  // The one shared runs list, for the per-card relocation state band (relocationBand.ts).
  const [runs, setRuns] = useState<RunView[]>([]);
  // The purge dialog's prefill: {} = opened blank from the header button, {name, clusterId} = opened
  // from a Detected row whose identity the scan already named (the retype arming is unchanged).
  const [purgeDialog, setPurgeDialog] = useState<{ name?: string; clusterId?: string } | null>(null);
  // The DETECTED scan. null = never run: the scan fetches every active
  // cluster's install branch server-side, so it is bound to an explicit operator action and must
  // NEVER fire on page load (the same rule as the tenant orphan scan). `detScanning` drives the
  // in-flight feedback; `detScanError` holds a failed REQUEST (the route answers a failed scan
  // fail-soft, inside the payload's `error`).
  const [detScan, setDetScan] = useState<DetectedScanView | null>(null);
  const [detScanning, setDetScanning] = useState(false);
  const [detScanError, setDetScanError] = useState<string | null>(null);
  // The detected consumer whose ADOPT confirmation is open (null = closed) — always a SELECTION from
  // a scan row, never typed: adopt is aimed with the identity the scan handed over.
  const [adoptFor, setAdoptFor] = useState<DetectedConsumerView | null>(null);

  function refresh(): void {
    listConsumers()
      .then(setRows)
      .catch((e: unknown) => setError(msg(e)));
    // The band is contextual, never load-bearing: a failed runs read leaves the cards intact.
    listRuns()
      .then(setRuns)
      .catch(() => setRuns([]));
  }
  useEffect(refresh, []);

  async function act(fn: (id: string) => Promise<{ runId: string }>, appId: string): Promise<void> {
    setError(null);
    try {
      const { runId } = await fn(appId);
      nav(`/runs/${runId}`);
    } catch (err) {
      setError(msg(err));
    }
  }

  // Purge is keyed on name+stage+cluster (an orphan has no appId), so it takes the dialog's input
  // rather than a row id — otherwise identical to `act`: plan the run, then open the Run screen.
  async function purge(input: PurgeInput): Promise<void> {
    setError(null);
    try {
      const { runId } = await purgeConsumer(input);
      nav(`/runs/${runId}`);
    } catch (err) {
      setError(msg(err));
    }
  }

  async function runDetectedScan(): Promise<void> {
    setDetScanning(true);
    setDetScanError(null);
    try {
      setDetScan(await scanDetectedConsumers());
    } catch (e) {
      setDetScan(null); // never leave a previous result standing under a failed re-scan
      setDetScanError(msg(e));
    } finally {
      setDetScanning(false);
    }
  }

  // Adopt is keyed on name+stage+cluster like purge (a detected consumer has no appId — that absence
  // is the whole problem) and, like every lifecycle action, only PLANS the run and hands off to the
  // Run screen, where the operator watches the live attest and approves the row write.
  async function adopt(d: DetectedConsumerView): Promise<void> {
    setError(null);
    try {
      const { runId } = await adoptConsumer({ consumerName: d.name, stage: d.stage, clusterId: d.clusterId });
      nav(`/runs/${runId}`);
    } catch (err) {
      setError(msg(err));
    }
  }

  // Offboarded consumers keep their inventory row for audit but have nothing live to
  // reconcile, so they are hidden from the Reconciliation tab — and surfaced in their own list
  // below, because ONE verb still applies to them: Restore rebuilds such a consumer from its
  // Storage Box folder.
  const visibleRows = rows?.filter((c) => c.status !== "offboarded") ?? null;
  const offboardedRows = rows?.filter((c) => c.status === "offboarded") ?? [];

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">Consumers</h2>
          <p className="page__desc">External apps this controller has onboarded onto the clusters.</p>
        </div>
        <div className="page__actions">
          {/* Scan every active cluster's install branch for consumers whose GitOps pointer stands with
              NO inventory row. Deliberately a header BUTTON, not a tab: a scan is an occasional
              recovery action that fetches the install branches server-side, so it is bound to an explicit
              click and its result surfaces on demand (below), never on page load. */}
          <button type="button" className="btn" onClick={() => void runDetectedScan()} disabled={detScanning}>
            {detScanning ? "Scanning…" : "Scan for untracked consumers"}
          </button>
          {/* Force-remove an ORPHAN (a failed onboard that never got an inventory row, so it has no
              row to offboard). Keyed on name+cluster, destructive → its own type-to-confirm dialog. */}
          <button type="button" className="btn btn--danger" onClick={() => setPurgeDialog({})}>
            Purge orphan
          </button>
          <Link className="btn btn--primary" to="/consumers/onboard">
            Onboard a consumer
          </Link>
        </div>
      </header>

      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}

      {/* DETECTED scan results — surfaced INLINE on demand from the header's
          "Scan for untracked consumers" button, NOT as a tab. A detected consumer exists in GitOps (its
          pointer generates the live app) but has NO inventory row, so it appears nowhere on the
          Reconciliation view below and cannot be offboarded. The panel names both sides — what the
          pointer SAYS beside a live cluster PROBE — because only the probe is the live truth, and it
          renders the honesty branches (a failed scan is never a silent all-clear). Shown only once a scan
          has actually run; Dismiss clears it. */}
      {(detScanning || detScanError !== null || detScan !== null) && (
        <section className="detected-scan" aria-label="Untracked consumers">
          <p className="note">
            <strong>Detected</strong> consumers stand in GitOps but carry <strong>no inventory row</strong> — an onboard that died
            before record-inventory, or a hand-written pointer. <strong>Adopt</strong> reconstructs the row from the pointer (a Run
            with a live attest; nothing on the cluster changes) — <strong>Purge</strong> force-removes the whole footprint instead.
          </p>
          <DetectedConsumerPanel
            scanning={detScanning}
            scanError={detScanError}
            scan={detScan}
            onAdopt={setAdoptFor}
            onPurge={(d) => setPurgeDialog({ name: d.name, clusterId: d.clusterId })}
          />
          <div className="page__actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDetScan(null);
                setDetScanError(null);
              }}
            >
              Dismiss
            </button>
          </div>
        </section>
      )}

      <div className="tabs" role="tablist" aria-label="Consumers view">
        <button
          type="button"
          role="tab"
          id="tab-recon"
          aria-selected={tab === "live"}
          aria-controls="panel-recon"
          className={tab === "live" ? "tab tab--active" : "tab"}
          onClick={() => setTab("live")}
        >
          Reconciliation
        </button>
        <button
          type="button"
          role="tab"
          id="tab-runs"
          aria-selected={tab === "runs"}
          aria-controls="panel-runs"
          className={tab === "runs" ? "tab tab--active" : "tab"}
          onClick={() => setTab("runs")}
        >
          Runs
        </button>
      </div>

      <div role="tabpanel" id="panel-recon" aria-labelledby="tab-recon" hidden={tab !== "live"}>
        {!visibleRows ? (
          <div className="loading">
            <span className="spinner" aria-hidden="true" />
            Loading consumers…
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="empty">
            <p>No active consumers.</p>
          </div>
        ) : (
          <ul className="cards">
            {visibleRows.map((c) => (
              <li key={c.id} className="card servercard">
                <div className="card__head">
                  <strong className="servercard__name">{c.name}</strong>
                  <span className={`badge badge--${c.status}`}>{c.status}</span>
                </div>
                {/* No recorded revision: the unit's pin lives on its delivery branch and is the
                    release cycle's to write — the live Drift row below shows what actually runs. */}
                <div className="servercard__target">
                  {c.domain} · {c.stage}
                </div>
                {/* Row facts only. The unit's public address is NOT one of them — it is
                    <name>.<unitApex>, and the apex comes off the target cluster's values chain — so
                    it arrives with the live payload below. */}
                <div className="servercard__chips">
                  <span className="chip">{c.provenance}</span>
                  {c.repoUrl && <span className="chip">{c.repoUrl.replace(/^https:\/\//, "").replace(/\.git$/, "")}</span>}
                </div>

                <ConsumerLive appId={c.id} />

                {/* The relocation state band: an open or failed backup/restore/move of THIS
                    unit surfaces here, off the one shared runs table, linking to its Run screen. */}
                {(() => {
                  const band = relocationRun(c.id, runs);
                  return band ? (
                    <p className="servercard__run">
                      <Link to={`/runs/${band.id}`}>{relocationLine(band)} →</Link>
                    </p>
                  ) : null;
                })()}

                <div className="actions">
                  {c.status === "active" && (
                    <button type="button" className="btn" onClick={() => setLifecycle({ c, action: "suspend" })}>
                      Suspend
                    </button>
                  )}
                  {c.status === "suspended" && (
                    <button type="button" className="btn btn--primary" onClick={() => setLifecycle({ c, action: "resume" })}>
                      Resume
                    </button>
                  )}
                  {/* Offered whatever the status: a ceiling is a property of the namespace, and a
                      suspended consumer still owns one — sizing it before resuming is the sane order. */}
                  {c.status !== "offboarded" && (
                    <button type="button" className="btn" onClick={() => setSizeFor(c)}>
                      Set size…
                    </button>
                  )}
                  {/* Only on a RUNNING consumer: a suspended one renders no pod, so there is nothing
                      holding a stale value and nothing to roll. */}
                  {c.status === "active" && (
                    <button type="button" className="btn" onClick={() => setLifecycle({ c, action: "restart-workloads" })}>
                      Restart workloads
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => setBackupFor(c)}>
                    Back up
                  </button>
                  {c.status === "active" && (
                    <button type="button" className="btn" onClick={() => setRelocFor({ c, verb: "move" })}>
                      Move…
                    </button>
                  )}
                  {c.status !== "offboarded" && (
                    <button type="button" className="btn btn--danger" onClick={() => setConfirmTarget(c)}>
                      Offboard
                    </button>
                  )}
                  {c.lastRunId && (
                    <Link className="btn" to={`/runs/${c.lastRunId}`}>
                      Last run →
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <OffboardedConsumers rows={offboardedRows} runs={runs} onRestore={(c) => setRelocFor({ c, verb: "restore" })} />
      </div>

      <div role="tabpanel" id="panel-runs" aria-labelledby="tab-runs" hidden={tab !== "runs"}>
        <SectionRuns kinds={CONSUMER_RUN_KINDS} empty="No consumer runs yet — onboard a consumer to start one." />
      </div>

      {confirmTarget && (
        <TypeToConfirm
          title={`Offboard "${confirmTarget.name}"?`}
          expected={confirmTarget.name}
          confirmLabel="Offboard consumer"
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => {
            const t = confirmTarget;
            setConfirmTarget(null);
            void act(offboardConsumer, t.id);
          }}
        >
          <p>
            This removes the GitOps pointer and ArgoCD prunes the app&apos;s workloads and namespace on{" "}
            <strong>{confirmTarget.domain}</strong>, then <strong>permanently deletes the consumer&apos;s Vault secrets</strong> — the
            repo PAT and all ceremony secrets, every version, <strong>NOT recoverable</strong>. Only the inventory row is kept, marked
            offboarded.
          </p>
        </TypeToConfirm>
      )}

      {purgeDialog && (
        <PurgeOrphanDialog
          {...(purgeDialog.name ? { initialName: purgeDialog.name } : {})}
          {...(purgeDialog.clusterId ? { initialClusterId: purgeDialog.clusterId } : {})}
          onCancel={() => setPurgeDialog(null)}
          onConfirm={(input) => {
            setPurgeDialog(null);
            void purge(input);
          }}
        />
      )}

      {adoptFor && (
        <ConfirmDialog
          title={`Adopt "${adoptFor.name}"?`}
          confirmLabel="Plan adopt"
          onCancel={() => setAdoptFor(null)}
          onConfirm={() => {
            const d = adoptFor;
            setAdoptFor(null);
            void adopt(d);
          }}
        >
          <p>
            This <strong>plans</strong> an adopt run for <strong>{adoptFor.name}</strong> on <strong>{adoptFor.domain}</strong> (
            {adoptFor.stage}) and opens it — you <strong>approve on the next screen</strong>. The run attests the target cluster, records
            the live cluster + ArgoCD state into the run log, then <strong>reconstructs the missing inventory row from the GitOps
            registration</strong> (chart {adoptFor.pointer.chartPath}, provenance <strong>adopted</strong>).{" "}
            <strong>Nothing is deployed, validated or changed on the cluster</strong> — afterwards the consumer appears under Consumers
            and can be offboarded/suspended again.
          </p>
        </ConfirmDialog>
      )}

      {backupFor && (
        <ConsumerBackupDialog
          c={backupFor}
          onCancel={() => setBackupFor(null)}
          onConfirm={() => {
            const c = backupFor;
            setBackupFor(null);
            void act(backupConsumer, c.id);
          }}
        />
      )}

      {relocFor && (
        <ConsumerRelocationDialog
          c={relocFor.c}
          verb={relocFor.verb}
          onCancel={() => setRelocFor(null)}
          onConfirm={(targetClusterId) => {
            const { c, verb } = relocFor;
            setRelocFor(null);
            void act((id) => (verb === "move" ? migrateConsumer(id, targetClusterId) : restoreConsumer(id, targetClusterId)), c.id);
          }}
        />
      )}

      {sizeFor && (
        <SetSizeDialog
          unit={sizeFor.name}
          kind="consumer" unitId={sizeFor.id}
          scope="its namespace"
          onCancel={() => setSizeFor(null)}
          onConfirm={(size) => { const c = sizeFor; setSizeFor(null); void act((id) => setConsumerSize(id, size), c.id); }}
        />
      )}

      {lifecycle && (
        <ConsumerLifecycleDialog
          name={lifecycle.c.name}
          action={lifecycle.action}
          onCancel={() => setLifecycle(null)}
          onConfirm={(call) => {
            const { c } = lifecycle;
            setLifecycle(null);
            void act(call, c.id);
          }}
        />
      )}
    </section>
  );
}
