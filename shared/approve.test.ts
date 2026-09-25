import { describe, it, expect } from "vitest";
import { approveIsComplete, MACHINE_PASSWORD_SECRET, type OperatorInput } from "./approve.ts";

// WHAT A PERSON HAS TO TYPE BEFORE A RUN MAY START.
//
// The rule decides one thing: every credential the plan asked for carries a value, and so does every
// answer. It sits here rather than in the form because the form renders and this decides — the same
// split the tailnet offer has, and the reason a test can reach it.
//
// WHAT A PLAN MAY LIST IS THE OTHER HALF OF THE RULE, and it is what makes the rule this simple. An
// answer an installation has already written down is read off its cluster map by the run definition
// (server/domains/runs/defs/deploy-slave.ts slaveMachineAnswers) and never listed here, so what is
// left on a card is what only a person can state — and a blank in one of those is an omission.

const ELEVATION = MACHINE_PASSWORD_SECRET;

/** The answers the two plans that list any actually ask for, by their real fields: a tenant's object
 *  store endpoint (server/domains/units/create-tenant.run.ts) and the first administrator's mailbox a
 *  unit's own manifest prompts for (server/domains/units/onboard.run.ts). Spelled out rather than
 *  imported, because `shared/` imports nothing from `server/` (the boundary law's shared-is-pure). */
const PLAN_ANSWERS: OperatorInput[] = [
  { field: "storageEndpoint", label: "R2 endpoint of the tenant's bucket" },
  { field: "email", label: "First administrator email" },
];

/** Every answer filled. */
const ANSWERED = {
  storageEndpoint: "https://acct.r2.cloudflarestorage.com",
  email: "info@example.com",
};

describe("what has to be typed before a run may start", () => {
  it("is complete once every credential and every answer carries a value", () => {
    expect(approveIsComplete({
      requiredSecrets: [ELEVATION],
      requiredInputs: PLAN_ANSWERS,
      secrets: { [ELEVATION]: "hunter2" },
      inputs: ANSWERED,
    })).toBe(true);
  });

  it("is incomplete while ANY answer is blank", () => {
    // The counter-probe of the case above: the complete verdict there means every field was really
    // read, and not that nothing was being checked.
    for (const missing of ["storageEndpoint", "email"]) {
      const inputs = { ...ANSWERED, [missing]: "" };
      expect(approveIsComplete({
        requiredSecrets: [ELEVATION],
        requiredInputs: PLAN_ANSWERS,
        secrets: { [ELEVATION]: "hunter2" },
        inputs,
      }), `${missing} left blank`).toBe(false);
    }
  });

  it("is incomplete while a credential is missing, whatever the answers say", () => {
    expect(approveIsComplete({
      requiredSecrets: [ELEVATION],
      requiredInputs: PLAN_ANSWERS,
      secrets: {},
      inputs: ANSWERED,
    })).toBe(false);
  });

  it("reads whitespace as blank, in a credential and in an answer alike", () => {
    // A field somebody tabbed through carries a space, and a space is not an answer.
    expect(approveIsComplete({
      requiredSecrets: [ELEVATION],
      requiredInputs: PLAN_ANSWERS,
      secrets: { [ELEVATION]: "   " },
      inputs: ANSWERED,
    })).toBe(false);
    expect(approveIsComplete({
      requiredSecrets: [ELEVATION],
      requiredInputs: PLAN_ANSWERS,
      secrets: { [ELEVATION]: "hunter2" },
      inputs: { ...ANSWERED, email: "  " },
    })).toBe(false);
  });

  it("is complete where the plan asks for nothing at all", () => {
    // The card every cluster run kind now shows once its password is typed: the answers those
    // programs declare stand in the cluster map, so the plan lists no input.
    expect(approveIsComplete({ requiredSecrets: [], requiredInputs: [], secrets: {}, inputs: {} })).toBe(true);
  });

  it("does not care what stands in a field the plan never asked for", () => {
    expect(approveIsComplete({
      requiredSecrets: [],
      requiredInputs: [],
      secrets: { "some-other-key": "" },
      inputs: { something_else: "" },
    })).toBe(true);
  });
});
