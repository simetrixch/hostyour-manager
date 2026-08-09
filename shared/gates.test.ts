import { describe, it, expect } from "vitest";
import { GateResultSchema, GateReportSchema, hardGatesPass, reportHashPayload, type GateResult } from "./gates.ts";

// A valid passing gate; override fields per case.
function gate(over: Record<string, unknown> = {}): unknown {
  return {
    id: "G8",
    title: "image discipline",
    severity: "hard",
    status: "pass",
    expected: "every rendered container image carries a tag other than latest, or an @<algo>:<hex> digest",
    found: "3 image reference(s), none mutable",
    reason: null,
    detail: "ok",
    ...over,
  };
}

describe("GateResult — the fail-closed refinement", () => {
  it("accepts a pass with reason=null", () => {
    expect(GateResultSchema.safeParse(gate()).success).toBe(true);
  });

  it("rejects a pass that carries a reason", () => {
    expect(GateResultSchema.safeParse(gate({ reason: "should not be here" })).success).toBe(false);
  });

  it("rejects a fail with reason=null (a rejection must always say why)", () => {
    expect(GateResultSchema.safeParse(gate({ status: "fail", reason: null })).success).toBe(false);
  });

  it("accepts a fail with a reason", () => {
    const g = gate({
      status: "fail",
      found: 'Service "acme-web" renders spec.type: NodePort',
      reason: "NodePort binds a cluster-global port on a single-node cluster; this is a hard gate",
    });
    expect(GateResultSchema.safeParse(g).success).toBe(true);
  });

  it("accepts a soft warn with a reason", () => {
    const g = gate({ id: "G11", severity: "soft", status: "warn", reason: "no resources.requests" });
    expect(GateResultSchema.safeParse(g).success).toBe(true);
  });

  it("caps expected/found/reason at 2000 chars", () => {
    expect(GateResultSchema.safeParse(gate({ found: "x".repeat(2001) })).success).toBe(false);
  });

  it("rejects an unknown gate id shape", () => {
    expect(GateResultSchema.safeParse(gate({ id: "gate5" })).success).toBe(false);
  });

  it("accepts the tenant T-gate ids (id regex widened to /^[GT][0-9]{1,2}$/)", () => {
    for (const id of ["T1", "T2", "T3", "T4"]) {
      expect(GateResultSchema.safeParse(gate({ id })).success).toBe(true);
    }
  });

  it("still rejects an out-of-namespace gate-id prefix", () => {
    expect(GateResultSchema.safeParse(gate({ id: "X1" })).success).toBe(false);
    expect(GateResultSchema.safeParse(gate({ id: "T" })).success).toBe(false);
    expect(GateResultSchema.safeParse(gate({ id: "T123" })).success).toBe(false);
  });
});

describe("hardGatesPass — the verdict's hard-gate leg", () => {
  it("passes when every hard gate passes, ignoring soft warnings", () => {
    const gates = [
      gate(),
      gate({ id: "G11", severity: "soft", status: "warn", reason: "noisy neighbor" }),
    ] as GateResult[];
    expect(hardGatesPass(gates)).toBe(true);
  });

  it("fails when any hard gate fails", () => {
    const gates = [gate({ status: "fail", reason: "rejected" })] as GateResult[];
    expect(hardGatesPass(gates)).toBe(false);
  });
});

describe("GateReport — top-level shape", () => {
  it("validates a minimal well-formed report", () => {
    const report = {
      contractVersion: "1.3",
      runnerVersion: "0.1.0",
      repoURL: "https://github.com/example/app.git",
      requestedRef: "main",
      resolvedSha: "0".repeat(40),
      startedAt: 1,
      finishedAt: 2,
      manifest: null,
      dependencies: [],
      gates: [gate()],
      sandbox: {
        mustFailTargets: ["https://10.1.1.1:443/"],
        mustFailTargetsConfirmedListening: true,
        mustFailDenied: true,
        controllerAddrDenied: true,
        mustPassReached: true,
      },
      verdict: "pass",
      reportHash: "abc",
    };
    expect(GateReportSchema.safeParse(report).success).toBe(true);
  });

  it("rejects a report with a non-40-char resolvedSha", () => {
    const bad = { resolvedSha: "deadbeef" };
    expect(GateReportSchema.safeParse({ ...bad }).success).toBe(false);
  });
});

describe("reportHashPayload — the canonical serialization the reportHash digests", () => {
  it("is independent of property insertion order, at every depth", () => {
    expect(reportHashPayload({ b: 1, a: { d: 2, c: 3 } })).toBe(reportHashPayload({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("keeps array order — the gate sequence is part of what the digest attests", () => {
    expect(reportHashPayload([3, 1, 2])).toBe("[3,1,2]");
    expect(reportHashPayload([3, 1, 2])).not.toBe(reportHashPayload([1, 2, 3]));
  });
});
