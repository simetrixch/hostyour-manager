// The Controller's port to the credential-free gate-runner. The concrete impl
// dispatches an in-cluster Tekton PipelineRun (gate-runner-tekton.ts) in the locked-down, egress-fenced
// `gate-runner` namespace and reads the frozen GateReport back from the ConfigMap the run publishes;
// the fake (testing/fake.ts) scripts a report.
//
// The pipeline clones the repo itself at the PINNED SHA (the Controller resolved + pinned that SHA
// first) — github egress is the one egress the fence allows. A private repo's read credential rides as
// a short-lived Secret the Controller creates in the gate namespace (repoCredentialId); a public repo
// needs none. The gate pod holds NO cluster token and cannot reach the cluster LAN / the Controller.
import type { GateReport, GateResult } from "../../../shared/gates.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";

/** A validation job. No token reaches the gate pod for a PUBLIC repo; a PRIVATE repo's read credential
 *  is named by `repoCredentialId` (opened + written to a short-lived Secret the clone step mounts). */
export interface GateJobRequest {
  targetName: string;
  stage: Stage;
  chartPath: string;
  repoURL: string;
  requestedRef: string;
  resolvedSha: string; // the pinned 40-char SHA the pipeline clones at
  /** The target cluster's values chain, VERBATIM and in layering order — the render's only value
   *  source besides the chart's own values files. */
  clusterValueFiles: readonly ClusterValueFile[];
  mustFailTargetsConfirmedListening: boolean; // the Controller's confirmed-listening attestation
  repoCredentialId?: string; // read credential for a PRIVATE repo clone; omitted = public/anon
}

export type GateJobPhase = "cloning" | "resolving" | "gating" | "done";

export interface GateJobProgress {
  phase: GateJobPhase;
  gatesSoFar: GateResult[]; // sandbox gates completed so far (streamed as they finish)
  report?: GateReport; // present iff phase === "done"
}

export interface GateRunner {
  /** Submit a validation job. Throws RUNNER_BUSY (the queue-of-1 is busy) or SANDBOX_DEGRADED
   *  (the fence self-probe was not green) — both fail-closed. */
  submit(req: GateJobRequest): Promise<{ jobId: string }>;
  /** Poll a job's progress; `report` attaches once the phase reaches "done". */
  poll(jobId: string): Promise<GateJobProgress>;
  /** Abort a running job (operator discard). No-op if the job is already done or unknown. */
  cancel(jobId: string): Promise<void>;
}
