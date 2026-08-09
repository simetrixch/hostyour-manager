// A scripted gate-runner for tests. Hand it the report to return (or flip it busy/degraded) and
// assert what the onboarding domain does with it — no sandbox, no helm, no network. It records
// every submitted request so a test can assert the credential-free, bundle-only contract.
import { errRunnerBusy, errSandboxDegraded, errNotFound } from "../../../kernel/errors.ts";
import type { GateRunner, GateJobRequest, GateJobProgress } from "../port.ts";
import type { GateReport } from "../../../../shared/gates.ts";

export interface FakeGateRunnerScript {
  report?: GateReport;
  busy?: boolean; // submit() throws RUNNER_BUSY
  degraded?: boolean; // submit() throws SANDBOX_DEGRADED
}

export class FakeGateRunner implements GateRunner {
  readonly submitted: GateJobRequest[] = [];
  private readonly jobs = new Map<string, GateJobProgress>();
  private seq = 0;

  constructor(private script: FakeGateRunnerScript = {}) {}

  /** Swap the scripted outcome between calls (e.g. plan's job vs. the revalidate-at-pin job). */
  setScript(script: FakeGateRunnerScript): void {
    this.script = script;
  }

  async submit(req: GateJobRequest): Promise<{ jobId: string }> {
    if (this.script.busy) throw errRunnerBusy();
    if (this.script.degraded) throw errSandboxDegraded();
    this.submitted.push(req);
    const jobId = `job_${++this.seq}`;
    this.jobs.set(jobId, {
      phase: "done",
      gatesSoFar: this.script.report?.gates ?? [],
      ...(this.script.report ? { report: this.script.report } : {}),
    });
    return { jobId };
  }

  async poll(jobId: string): Promise<GateJobProgress> {
    const j = this.jobs.get(jobId);
    if (!j) throw errNotFound(`gate-runner job ${jobId}`);
    return j;
  }

  async cancel(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
  }
}
