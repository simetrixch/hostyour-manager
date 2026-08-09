import { describe, it, expect } from "vitest";
import { DRIFT_VERDICT } from "../../shared/enums.ts";
import { sha7, driftReadout } from "./reconVocabulary.ts";

// The words + renderings the reconciliation drift row is allowed to use, tested here rather than through
// ReconDrift.tsx because they are pure — the same factoring tenantPlacement.test.ts and tenantRows.test.ts
// describe (vitest.config.ts runs web/**/*.test.ts in the node environment; there is no DOM harness in this
// repo). What is under test is not spelling — it is the CLAIM each verdict word makes: only a real
// comparison earns the green tone, and the two neutral non-verdicts ("not-deployed", "unknown") must never
// wear it — the false-green regressions the suspend fix turned on (server driftOf).

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"; // 40 chars, as every revision in this product is

describe("reconciliation vocabulary", () => {
  // A revision is 7 characters everywhere, and the absence of one is the WORD "none", never an empty
  // string: "pinned none · deployed none" is the honest reading of a suspended consumer (its pointer
  // generates no Application, so there is nothing to pin and nothing to run), and an empty span would
  // read as a broken card instead of as that fact.
  it("renders a revision as 7 chars, and a missing one as the stated word 'none'", () => {
    expect(sha7(SHA)).toBe("1a2b3c4");
    expect(sha7(null)).toBe("none");
  });

  // THE REGRESSION for the false green the suspend fix introduced. A unit whose pointer generates no
  // Application has nothing pinned and nothing deployed, so the server compares nothing and answers
  // "not-deployed" (driftOf / deploymentVerdict). That state is reached BOTH by a finished consumer suspend
  // and by a resume that died at watch-sync — which leaves apps.status = "suspended" while the pointer
  // stands in active/ pinning a SHA, i.e. a consumer that is pinned with NOTHING RUNNING. Painting it with
  // the green ✓ badge told the operator that consumer was fine. Whatever the word, this verdict may never
  // wear the healthy tone.
  it("the 'not-deployed' verdict is NEUTRAL — never the green tone a comparison earns", () => {
    expect(driftReadout("not-deployed")).toEqual({ word: "not deployed", tone: "bare" });
    expect(driftReadout("not-deployed").tone).not.toBe("healthy");
    // Only a real comparison earns green, and only a real disagreement earns the warning tone.
    expect(driftReadout("converged")).toEqual({ word: "in sync", tone: "healthy" });
    expect(driftReadout("drift")).toEqual({ word: "drift", tone: "degraded" });
    // The other non-verdict is neutral too, and keeps its OWN word: "unknown" means ArgoCD could not be
    // read, and saying that about a suspended unit would claim blindness the product does not have.
    expect(driftReadout("unknown")).toEqual({ word: "unknown", tone: "bare" });
    expect(driftReadout("unknown").word).not.toBe(driftReadout("not-deployed").word);
  });

  // Every member of DRIFT_VERDICT must have a word and a tone, and the four must stay four distinct words:
  // a verdict added to the list (shared/enums.ts) with no readout would render `undefined` in a badge, and
  // two verdicts sharing a word would put the product back where every earlier drift defect started — one word
  // standing for two different facts.
  it("names every verdict the server can answer with, each under its own word", () => {
    const words = DRIFT_VERDICT.map((v) => driftReadout(v).word);
    expect(words.every((w) => w.length > 0)).toBe(true);
    expect(new Set(words).size).toBe(DRIFT_VERDICT.length);
  });
});
