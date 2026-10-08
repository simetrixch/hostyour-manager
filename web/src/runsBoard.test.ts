import { describe, expect, it } from "vitest";
import type { LockView, QueuedRunView, RunView } from "../../shared/api-types.ts";
import { currentStepOf, formatElapsed, isOpenRun, locksHeldBy, queueLine, usualDurationOf } from "./runsBoard.ts";

const run = (over: Partial<RunView>): RunView => ({
  id: "run_1", kind: "noop", targetKind: "server", targetId: "srv_1", status: "running", summary: "", startedBy: "System",
  steps: [], createdAt: 0, startedAt: 0, endedAt: null, deletedAt: null, cleanupsRegistered: false, aborted: false,
  requiredSecrets: [], optionalSecrets: [], requiredInputs: [], findings: [], secretHints: {}, ...over,
});
const step = (title: string, status: RunView["steps"][number]["status"]) => ({ name: title, title, status, startedAt: null, endedAt: null });
const lock = (runId: string): LockView => ({ resource: "master-kube", key: "m", runId, acquiredAt: 0 });
const queuedRun = (over: Partial<QueuedRunView> = {}): QueuedRunView => ({
  runId: "run_1", kind: "noop", targetKind: "server", targetId: "srv_1",
  place: 1, approvedAt: 0, needsSecrets: false, waitsFor: [], ...over,
});

describe("the runs board", () => {
  it("keeps a run open while it has not ended, and a failed run while it holds a lock", () => {
    for (const status of ["planning", "planned", "queued", "approved", "running"] as const) expect(isOpenRun(run({ status }), [])).toBe(true);
    expect(isOpenRun(run({ status: "failed" }), [lock("run_1")])).toBe(true);
    expect(isOpenRun(run({ status: "failed" }), [lock("run_2")])).toBe(false);
    expect(isOpenRun(run({ status: "succeeded" }), [])).toBe(false);
  });

  it("lists only the locks the run itself holds", () => {
    expect(locksHeldBy("run_1", [lock("run_1"), { ...lock("run_2"), resource: "git-branch", key: "deploy@main" }])).toEqual(["master-kube m"]);
  });

  it("names the running step, the failed step, or the wait", () => {
    expect(currentStepOf(run({ steps: [step("Attest", "ok"), step("Write", "running")] }))).toBe("Write");
    expect(currentStepOf(run({ status: "failed", steps: [step("Attest", "ok"), step("Write", "failed")] }))).toBe("stopped at Write");
    expect(currentStepOf(run({ status: "planned" }))).toBe("waiting for approval");
    expect(currentStepOf(run({ status: "queued" }))).toBe("queued");
  });

  it("gives the usual time with its sample size, and says when a kind has none", () => {
    const durations = [{ kind: "noop", typicalMs: 7 * 60_000 + 20_000, sampleSize: 12 }];
    expect(usualDurationOf("noop", durations)).toBe("usually ~7 min (from 12 earlier runs)");
    expect(usualDurationOf("noop", [{ kind: "noop", typicalMs: 10_000, sampleSize: 1 }])).toBe("usually ~1 min (from 1 earlier run)");
    expect(usualDurationOf("cluster-redeploy", durations)).toBe("no earlier run of this kind has succeeded, so there is no usual time yet");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(5 * 60_000)).toBe("5m");
    expect(formatElapsed(125 * 60_000)).toBe("2h 5m");
  });
});

describe("queueLine", () => {
  it("reports when a queued run needs secrets re-entered", () => {
    expect(queueLine(queuedRun({ needsSecrets: true }))).toBe("needs its password again on its run page");
  });

  it("reports when a queued run starts now", () => {
    expect(queueLine(queuedRun({ needsSecrets: false, waitsFor: [] }))).toBe("starts now");
  });

  it("reports the resources and holders a queued run waits for", () => {
    expect(
      queueLine(
        queuedRun({
          needsSecrets: false,
          waitsFor: [
            { resource: "master-kube", key: "m", holderRunId: "run_9" },
            { resource: "git-branch", key: "deploy@main", holderRunId: "run_8" },
          ],
        }),
      ),
    ).toBe("waits for master-kube m (run run_9), git-branch deploy@main (run run_8)");
  });
});
