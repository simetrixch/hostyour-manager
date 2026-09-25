import { describe, it, expect } from "vitest";
import { assertRecoverable } from "./recover.ts";

// The recovery gate as a rule: what a run's status and its startedAt say about retry / skip / abort.
describe("assertRecoverable", () => {
  const at = (status: "failed" | "cancelled" | "succeeded" | "running", startedAt: Date | null) => ({ id: "run_1", status, startedAt });

  it("admits a failed run, and a run cancelled after it started (#203)", () => {
    expect(() => assertRecoverable(at("failed", null), "retry")).not.toThrow();
    expect(() => assertRecoverable(at("cancelled", new Date()), "retry")).not.toThrow();
  });

  it("refuses a plan discarded before its approve by name — it never started, so it is planned again", () => {
    expect(() => assertRecoverable(at("cancelled", null), "retry")).toThrow(/discarded before it started — nothing to retry; plan it again/);
    expect(() => assertRecoverable(at("cancelled", null), "skip")).toThrow(/nothing to skip/);
  });

  it("refuses every other status as not failed/cancelled", () => {
    expect(() => assertRecoverable(at("succeeded", new Date()), "retry")).toThrow(/is not failed\/cancelled/);
    expect(() => assertRecoverable(at("running", new Date()), "retry")).toThrow(/is not failed\/cancelled/);
  });
});
