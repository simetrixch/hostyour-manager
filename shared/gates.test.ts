import { describe, it, expect } from "vitest";
import { GateResultSchema, GateReportSchema, hardGatesPass, reportHashPayload, sandboxFailures, sandboxGreen, sandboxProvenance, type GateResult, type SandboxAttestation } from "./gates.ts";

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

describe("the verdict's sandbox leg — one predicate, read by the runner and the Manager", () => {
  const green: SandboxAttestation = {
    mustFailTargets: ["10.1.1.1:443"],
    mustFailTargetsDeclaredListening: true,
    mustFailDenied: true,
    managerAddrDenied: true,
    mustPassReached: true,
  };
  const LEGS = ["mustFailTargetsDeclaredListening", "mustFailDenied", "managerAddrDenied", "mustPassReached"] as const;

  it("INNOCENT CASE: an attestation whose every leg holds is green and names no failure", () => {
    expect(sandboxGreen(green)).toBe(true);
    expect(sandboxFailures(green)).toEqual([]);
  });

  it("goes red on EACH leg on its own, and says which one — so a refusal never rests on one leg alone", () => {
    for (const leg of LEGS) {
      const broken = { ...green, [leg]: false };
      expect(sandboxGreen(broken), `${leg} false must not be green`).toBe(false);
      expect(sandboxFailures(broken), `${leg} false must name exactly one failure`).toHaveLength(1);
    }
  });

  // The two are one answer read two ways — the boolean the code branches on and the words a person
  // reads. A leg that broke the predicate and produced no sentence would refuse a run and say nothing.
  it("names a failure for exactly the attestations the predicate refuses", () => {
    for (const leg of LEGS) {
      const broken = { ...green, [leg]: false };
      expect(sandboxGreen(broken)).toBe(sandboxFailures(broken).length === 0);
    }
    expect(sandboxGreen(green)).toBe(sandboxFailures(green).length === 0);
  });

  // An empty must-fail list proves nothing blocked, and fence.ts composes mustFailDenied false for it.
  // The sentence must not then claim the sandbox reached a target, because no target was probed.
  it("says an empty must-fail list proved nothing, rather than naming targets it never probed", () => {
    const none = { ...green, mustFailTargets: [], mustFailDenied: false };
    const said = sandboxFailures(none);
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain("reached");
  });
});

// WHAT THE FENCE PROOF RESTS ON. Three of the four legs are probes the runner made from inside the
// sandbox; the fourth is the Manager's word, and `sandboxFailures` says nothing about it when
// everything held — so a run that passed carried no record of the one leg nobody measured.
describe("sandboxProvenance — the record a GREEN run leaves", () => {
  const green: SandboxAttestation = {
    mustFailTargets: ["10.1.1.9:16443", "10.1.1.9:8484"],
    mustFailTargetsDeclaredListening: true,
    mustFailDenied: true,
    managerAddrDenied: true,
    mustPassReached: true,
  };

  it("names EVERY target the fence was proven against, because that is what nothing measured", () => {
    const said = sandboxProvenance(green);
    for (const t of green.mustFailTargets) expect(said, t).toContain(t);
  });

  // The same shape sandboxFailures guards: with no target configured there is nothing to name, and a
  // sentence naming an empty list would read as a target that was there.
  it("says nothing was configured rather than naming an empty list", () => {
    const said = sandboxProvenance({ ...green, mustFailTargets: [] });
    expect(said).toContain("none configured");
  });

  // It is the GREEN path's record and does not repeat what sandboxFailures says: a leg that did not
  // hold has its own sentence there, and two descriptions of one leg is how they come to disagree.
  it("is the green path's line — a failed leg is stated by sandboxFailures and not here", () => {
    expect(sandboxFailures(green)).toEqual([]);
    expect(sandboxGreen(green)).toBe(true);
  });
});

describe("GateReport — top-level shape", () => {
  it("validates a minimal well-formed report", () => {
    const report = {
      contractVersion: "1.5",
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
        mustFailTargetsDeclaredListening: true,
        mustFailDenied: true,
        managerAddrDenied: true,
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

  // THE VERSION LITERAL, held to what it claims: a report written against the PREVIOUS contract is
  // refused rather than read half-right. The runner and the Manager are separate images, and a pin
  // rolled back by hand pairs a new Manager with a runner whose report spells the sandbox's fourth
  // leg the old way — which would otherwise be read as undefined and therefore as not-green.
  it("refuses a report written against the previous contract version", () => {
    const wellFormed = {
      contractVersion: "1.5", runnerVersion: "0.1.0", repoURL: "https://github.com/example/app.git",
      requestedRef: "main", resolvedSha: "0".repeat(40), startedAt: 1, finishedAt: 2,
      manifest: null, dependencies: [], gates: [gate()],
      sandbox: { mustFailTargets: [], mustFailTargetsDeclaredListening: true, mustFailDenied: true, managerAddrDenied: true, mustPassReached: true },
      verdict: "pass", reportHash: "abc",
    };
    expect(GateReportSchema.safeParse(wellFormed).success).toBe(true);
    expect(GateReportSchema.safeParse({ ...wellFormed, contractVersion: "1.4" }).success).toBe(false);
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
