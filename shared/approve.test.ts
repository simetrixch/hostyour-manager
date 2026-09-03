import { describe, it, expect } from "vitest";
import { approveIsComplete, MACHINE_PASSWORD_SECRET, type OperatorInput } from "./approve.ts";

// WHAT A PERSON HAS TO TYPE BEFORE A RUN MAY START, and what they may leave alone.
//
// The rule decides one thing: every credential the plan asked for carries a value, and so does every
// answer that is not marked optional. It sits here rather than in the form because the form renders
// and this decides — the same split the tailnet offer has, and the reason a test can reach it.
//
// The case that mattered: a master's release asks for six answers, and three of them say "blank when
// it has none" or "blank for the snap's default" in their own label. Gating the button on those made
// the ceremony demand a value from a field that had just invited none, so the run could not be
// approved at all.

const ELEVATION = MACHINE_PASSWORD_SECRET;

/** The answers a master's release actually asks for, by their real fields and their real
 *  optionality — three that must be answered and three that may stay blank. */
const RELEASE_ANSWERS: OperatorInput[] = [
  { field: "committer_email", label: "The mailbox the regenerated branch's commits are made under" },
  { field: "letsencrypt_email", label: "The mailbox the certificate authority writes to" },
  { field: "letsencrypt_server", label: "The ACME directory this installation registers with" },
  { field: "lan_cidr", label: "The IPv4 range this machine shares — blank when it shares none", optional: true },
  { field: "storage_mount", label: "Where the separate storage is mounted — blank when it has none", optional: true },
  { field: "storage_subdirectory", label: "The directory under that mount — blank for the snap's default", optional: true },
];

/** Every answer that must be answered, filled. */
const ANSWERED = {
  committer_email: "mk@example.com",
  letsencrypt_email: "info@example.com",
  letsencrypt_server: "https://acme-v02.api.example.com/directory",
};

describe("what has to be typed before a run may start", () => {
  it("is complete with every optional answer left blank", () => {
    expect(approveIsComplete({
      requiredSecrets: [ELEVATION],
      requiredInputs: RELEASE_ANSWERS,
      secrets: { [ELEVATION]: "hunter2" },
      inputs: ANSWERED,
    })).toBe(true);
  });

  it("is incomplete while an answer that is NOT optional is blank", () => {
    // The counter-probe of the case above: the rule still holds the button when something real is
    // missing, so a complete verdict means the optional ones were let through and not that nothing
    // was being checked.
    for (const missing of ["committer_email", "letsencrypt_email", "letsencrypt_server"]) {
      const inputs = { ...ANSWERED, [missing]: "" };
      expect(approveIsComplete({
        requiredSecrets: [ELEVATION],
        requiredInputs: RELEASE_ANSWERS,
        secrets: { [ELEVATION]: "hunter2" },
        inputs,
      }), `${missing} left blank`).toBe(false);
    }
  });

  it("is incomplete while a credential is missing, whatever the answers say", () => {
    expect(approveIsComplete({
      requiredSecrets: [ELEVATION],
      requiredInputs: RELEASE_ANSWERS,
      secrets: {},
      inputs: ANSWERED,
    })).toBe(false);
  });

  it("reads whitespace as blank, in a credential and in an answer alike", () => {
    // A field somebody tabbed through carries a space, and a space is not an answer.
    expect(approveIsComplete({
      requiredSecrets: [ELEVATION],
      requiredInputs: RELEASE_ANSWERS,
      secrets: { [ELEVATION]: "   " },
      inputs: ANSWERED,
    })).toBe(false);
    expect(approveIsComplete({
      requiredSecrets: [ELEVATION],
      requiredInputs: RELEASE_ANSWERS,
      secrets: { [ELEVATION]: "hunter2" },
      inputs: { ...ANSWERED, committer_email: "  " },
    })).toBe(false);
  });

  it("is complete where the plan asks for nothing at all", () => {
    expect(approveIsComplete({ requiredSecrets: [], requiredInputs: [], secrets: {}, inputs: {} })).toBe(true);
  });

  it("does not care what stands in a field the plan never asked for", () => {
    expect(approveIsComplete({
      requiredSecrets: [],
      requiredInputs: [{ field: "storage_mount", label: "blank when it has none", optional: true }],
      secrets: { "some-other-key": "" },
      inputs: { something_else: "" },
    })).toBe(true);
  });
});
