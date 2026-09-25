import type { ConsumerLiveProbeView, WorkloadStatusView } from "../../../shared/api-types.ts";
import { ReconDrift } from "./ReconDrift.tsx";

/** The three FACT rows of one live reconciliation card — the cluster smoke, the ArgoCD status, and
 *  the drift verdict (ReconDrift) — rendered ONCE for every consumer surface that answers in the live
 *  envelope: the Consumers row card (ConsumerLiveView, which extends the probe view) and the Detected
 *  panel's name-keyed probe (ConsumerLiveProbeView). One renderer for the same
 *  reason the server computes the answer in one place (live-recon.ts): two copies of these rows is how
 *  two cards drift into describing the same live situation differently. The CALLER keeps the fetch and
 *  the loading/error/not-configured branches — their wording is per-surface; the facts are not. */
export function LiveReconFacts({ live }: { live: Pick<ConsumerLiveProbeView, "cluster" | "argo" | "drift" | "argocdUrl"> }) {
  return (
    <div className="recon">
      <div className="recon__row">
        <span className="recon__label">Cluster</span>
        {live.cluster === null ? (
          <span className="recon__fact">—</span>
        ) : !live.cluster.ok ? (
          <span className="recon__err">{live.cluster.error}</span>
        ) : (
          <>
            <Fact ok={live.cluster.namespaceExists} label={live.cluster.namespaceExists ? "namespace" : "no namespace"} />
            <WorkloadFact workloads={live.cluster.workloads} />
            <Fact ok={live.cluster.externalSecretsReady} label={live.cluster.externalSecretsReady ? "secrets synced" : "secrets not ready"} />
          </>
        )}
      </div>

      <div className="recon__row">
        <span className="recon__label">ArgoCD</span>
        {live.argo === null ? (
          <span className="recon__fact">—</span>
        ) : !live.argo.ok ? (
          <span className="recon__err">{live.argo.error}</span>
        ) : (
          <>
            <span className={`recon__fact recon__fact--${live.argo.sync === "Synced" ? "ok" : "warn"}`}>{live.argo.sync}</span>
            <span className={`recon__fact recon__fact--${healthTone(live.argo.health)}`}>{live.argo.health}</span>
          </>
        )}
        {live.argocdUrl && (
          <a className="recon__link" href={live.argocdUrl} target="_blank" rel="noreferrer">
            open in ArgoCD ↗
          </a>
        )}
      </div>

      {live.drift && <ReconDrift drift={live.drift} />}
    </div>
  );
}

/** ArgoCD health → a tone token (Healthy good, Degraded/Missing bad, the rest cautionary). */
function healthTone(h: string): "ok" | "warn" | "down" {
  if (h === "Healthy") return "ok";
  if (h === "Degraded" || h === "Missing") return "down";
  return "warn";
}

/** One ✓/✕ live fact (namespace present, ExternalSecrets ready, …). */
function Fact({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`recon__fact recon__fact--${ok ? "ok" : "down"}`}>
      {ok ? "✓" : "✕"} {label}
    </span>
  );
}

/** Workload availability rolled up: N of M available (cautionary tint when any is down). */
function WorkloadFact({ workloads }: { workloads: WorkloadStatusView[] }) {
  const up = workloads.filter((w) => w.available).length;
  const allUp = up === workloads.length;
  return (
    <span className={`recon__fact recon__fact--${allUp ? "ok" : "warn"}`}>
      {up}/{workloads.length} workloads
    </span>
  );
}
