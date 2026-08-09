import { describe, it, expect } from "vitest";
import { RUN_STATUS, STEP_STATUS } from "../../shared/enums.ts";
import { canRunTransition, assertRunTransition, canStepTransition, assertStepTransition, isTerminalRun, isDeletableRun } from "./transitions.ts";

const LEGAL_RUN = new Set([
  "planning>planned", "planning>failed", "planning>cancelled",
  "planned>approved", "planned>cancelled",
  "approved>running",
  "running>succeeded", "running>failed", "running>cancelled",
  "failed>running",
]);

// Restated here rather than derived from the table, so a change to the table has to be made twice —
// once in the code and once as a claim about what the executor does. The claim: nothing leaves `ok`,
// `ok` is reached only from `running`, and every other move the executor actually performs is legal.
const LEGAL_STEP = new Set([
  "pending>running", "pending>skipped", "pending>failed", "pending>pending",
  "running>ok", "running>failed", "running>pending", "running>skipped",
  "failed>pending", "failed>running", "failed>skipped", "failed>failed",
  "skipped>pending", "skipped>skipped",
  // The ONE way out of ok, and only for it: a second abort re-runs the first abort's cleanups,
  // because the run did new work in between. Nothing else moves an ok step.
  "ok>pending",
]);

describe("executor transition tables", () => {
  it("every run from→to matches the legal table, exhaustively", () => {
    for (const from of RUN_STATUS) {
      for (const to of RUN_STATUS) {
        expect(canRunTransition(from, to)).toBe(LEGAL_RUN.has(`${from}>${to}`));
      }
    }
  });

  it("every step from→to matches the legal table, exhaustively", () => {
    for (const from of STEP_STATUS) {
      for (const to of STEP_STATUS) {
        expect(canStepTransition(from, to)).toBe(LEGAL_STEP.has(`${from}>${to}`));
      }
    }
  });

  it("assertRunTransition throws on an illegal move and passes a legal one", () => {
    expect(() => assertRunTransition("succeeded", "running")).toThrow();
    expect(() => assertRunTransition("planned", "running")).toThrow();
    expect(() => assertRunTransition("failed", "running")).not.toThrow();
  });

  it("assertStepTransition throws on an illegal move", () => {
    expect(() => assertStepTransition("ok", "running")).toThrow();
    expect(() => assertStepTransition("running", "pending")).not.toThrow();
  });

  // The two rules the permissive table exists to hold. Everything else it allows, the executor
  // demonstrably does; these two it never does, and a change that made either possible would mean a
  // step that succeeded is being re-run, or one that never ran is being called done.
  it("ok leaves ONLY to pending, and only for a second abort's cleanup reset", () => {
    expect(() => assertStepTransition("ok", "pending")).not.toThrow();
    for (const to of STEP_STATUS) {
      if (to !== "pending") expect(() => assertStepTransition("ok", to)).toThrow();
    }
  });

  it("ok is reachable ONLY from running — no path declares a step done that never started", () => {
    for (const from of STEP_STATUS) {
      if (from === "running") expect(() => assertStepTransition(from, "ok")).not.toThrow();
      else expect(() => assertStepTransition(from, "ok")).toThrow();
    }
  });

  it("terminal run states are succeeded and cancelled (failed is not terminal)", () => {
    expect(isTerminalRun("succeeded")).toBe(true);
    expect(isTerminalRun("cancelled")).toBe(true);
    expect(isTerminalRun("failed")).toBe(false);
  });

  it("deletable = any settled state incl. succeeded; in-flight (planning/approved/running) never", () => {
    for (const s of RUN_STATUS) {
      expect(isDeletableRun(s)).toBe(s === "planned" || s === "failed" || s === "cancelled" || s === "succeeded");
    }
  });
});
