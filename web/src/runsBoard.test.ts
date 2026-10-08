import { afterEach, describe, it, expect, vi } from "vitest";
import { approveRun } from "./api.ts";
import type { LockView, RunView } from "../../shared/api-types.ts";
import { ApiRequestError } from "./request.ts";
import { busyHolderOf, currentStepOf, formatElapsed, isOpenRun, locksHeldBy, usualDurationOf } from "./runsBoard.ts";

const run = (over: Partial<RunView>): RunView => ({
  id: "run_1", kind: "noop", targetKind: "server", targetId: "srv_1", status: "running", summary: "", startedBy: "System",
  steps: [], createdAt: 0, startedAt: 0, endedAt: null, deletedAt: null, cleanupsRegistered: false, aborted: false,
  requiredSecrets: [], optionalSecrets: [], requiredInputs: [], findings: [], secretHints: {}, ...over,
});
const step = (title: string, status: RunView["steps"][number]["status"]) => ({ name: title, title, status, startedAt: null, endedAt: null });
const lock = (runId: string): LockView => ({ resource: "master-kube", key: "m", runId, acquiredAt: 0 });

describe("the runs board", () => {
  it("keeps a run open while it has not ended, and a failed run while it holds a lock", () => {
    for (const status of ["planning", "planned", "approved", "running"] as const) expect(isOpenRun(run({ status }), [])).toBe(true);
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

  it("reads the holder only from a busy refusal that carries one", () => {
    const detail = { resource: "master-kube", key: "m", holderRunId: "run_9" };
    expect(busyHolderOf(new ApiRequestError("Resource busy", "RESOURCE_BUSY", detail))).toEqual(detail);
    expect(busyHolderOf(new ApiRequestError("Resource busy", "RESOURCE_BUSY"))).toBeNull();
    expect(busyHolderOf(new ApiRequestError("Nope", "VALIDATION", detail))).toBeNull();
    expect(busyHolderOf(new Error("Resource busy"))).toBeNull();
  });
});

describe("a busy refusal over the wire", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the holder the server named, so the run page can link it", async () => {
    const detail = { resource: "git-branch", key: "deploy@main", holderRunId: "run_9" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "RESOURCE_BUSY", message: "Resource busy", detail }), { status: 409 })));
    const refused = await approveRun("run_1").then(() => null, (e: unknown) => e);
    expect(busyHolderOf(refused)).toEqual(detail);
  });
});
