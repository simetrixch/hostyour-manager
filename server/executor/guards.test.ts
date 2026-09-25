import { describe, it, expect } from "vitest";
import { assertGuardsArmed } from "./guards.ts";
import type { AnyRunDefinition } from "./types.ts";
import type { RunKind } from "../../shared/enums.ts";

// THE ATTEST-TARGET LAW: every registered mutating run definition starts with attest-target, and the
// guards.armed self-check refuses a boot where one does not.

describe("assertGuardsArmed", () => {
  it("passes an empty runDefinitions and rejects a mutating def without attest-target", () => {
    const empty = new Map<RunKind, AnyRunDefinition>();
    expect(() => assertGuardsArmed(empty)).not.toThrow();
    // A FABRICATED def under the fixture literal, never a real one: what is measured is the rule
    // itself — a mutating def whose step 0 is not attest-target — and keying it on a run kind that
    // really is mutating would read as a claim about that run kind's own steps.
    const bad = new Map<RunKind, AnyRunDefinition>([
      ["noop", { kind: "noop", mutating: true, steps: () => [{ name: "not-attest", title: "x", run: async () => undefined }] } as unknown as AnyRunDefinition],
    ]);
    expect(() => assertGuardsArmed(bad)).toThrow(/attest-target/);
  });
});
