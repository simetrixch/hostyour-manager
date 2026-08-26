// The Manager's port to the credential-free gate-runner. The concrete impl
// dispatches an in-cluster Tekton PipelineRun (gate-runner-tekton.ts) in the locked-down, egress-fenced
// `gate-runner` namespace and reads the frozen GateReport back from the ConfigMap the run publishes;
// the fake (testing/fake.ts) scripts a report.
//
// The pipeline clones the repo itself at the PINNED SHA (the Manager resolved + pinned that SHA
// first) — github egress is the one egress the fence allows. A private repo's read credential rides as
// a short-lived Secret the Manager creates in the gate namespace (repoCredentialId); a public repo
// needs none. The gate pod holds NO cluster token and cannot reach the cluster LAN / the Manager.
import type { GateReport, GateResult } from "../../../shared/gates.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";

/** A validation job. No token reaches the gate pod for a PUBLIC repo; a PRIVATE repo's read credential
 *  is named by `repoCredentialId` (opened + written to a short-lived Secret the clone step mounts). */
export interface GateJobRequest {
  targetName: string;
  stage: Stage;
  /** The chart directory inside the repo. ABSENT for a build-only unit — one that carries a build
   *  registration and no stage file, so nothing of it is ever deployed and there is no chart to
   *  render. The absence is the form itself, not a missing input: the gate reads it as "this unit
   *  ships no chart" and reports the chart-reading gates accordingly. */
  chartPath?: string;
  repoURL: string;
  requestedRef: string;
  resolvedSha: string; // the pinned 40-char SHA the pipeline clones at
  /** The target cluster's values chain, VERBATIM and in layering order — the render's only value
   *  source besides the chart's own values files. */
  clusterValueFiles: readonly ClusterValueFile[];
  mustFailTargetsConfirmedListening: boolean; // the Manager's confirmed-listening attestation
  repoCredentialId?: string; // read credential for a PRIVATE repo clone; omitted = public/anon
}

export type GateJobPhase = "cloning" | "resolving" | "gating" | "done";

export interface GateJobProgress {
  phase: GateJobPhase;
  gatesSoFar: GateResult[]; // sandbox gates completed so far (streamed as they finish)
  report?: GateReport; // present iff phase === "done"
}

export interface GateRunner {
  /** Submit a validation job.
   *
   *  RUNNER_BUSY IS A REFUSAL THE PORT ALLOWS AND NO IMPLEMENTATION MAKES TODAY. The Tekton adapter
   *  submits a PipelineRun and lets the cluster schedule it, so nothing there is a queue that can be
   *  full; the only caller of errRunnerBusy in the tree is the test double, which scripts it so the
   *  domain can be driven through that path. It stays in the contract because an implementation that
   *  serialises runs is the obvious next one and a caller has to be written for it — but a reader of
   *  this line must not go looking for the queue in the adapter, because there is none. */
  submit(req: GateJobRequest): Promise<{ jobId: string }>;
  /** Poll a job's progress; `report` attaches once the phase reaches "done".
   *
   *  Two refusals, and NEITHER is a finding about the repository under validation:
   *  GATE_INCOMPLETE when the job produced NO report, and SANDBOX_DEGRADED when the report it did
   *  produce carries a fence self-probe that was not green (shared/gates.ts sandboxGreen — the
   *  fence protects the cluster FROM the repository, so its failure is the platform's). Both are a
   *  different answer from a report whose verdict is "fail", which IS about the repository. */
  poll(jobId: string): Promise<GateJobProgress>;
  /** Abort a running job (operator discard). No-op if the job is already done or unknown. */
  cancel(jobId: string): Promise<void>;
}
