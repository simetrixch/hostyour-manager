/** What a person supplies before a run may start.
 *
 * A plan lists two kinds of thing. CREDENTIALS the manager does not hold, which travel under their
 * own keys and are sealed. And ANSWERS nothing this manager reads can state — a tenant's object
 * store endpoint, the first administrator's mailbox a unit's own manifest prompts for — which ride
 * the run under `activation-input:<field>` and are never sealed, because an answer is not a secret.
 * What an INSTALLATION has already written down is not among them: a cluster's own map states it and
 * the run definition reads it there (server/domains/runs/defs/deploy-slave.ts slaveMachineAnswers).
 */
/** The key the password of the MACHINE ACCOUNT rides under through approve (Plan.requiredSecrets →
 *  ctx.secrets). The spelling is the deployment engine's — the installation's ansiwise.yaml says
 *  `password_from_caller: true` and this is the name it hands the value over under — and it stands
 *  here, in the module about what a person supplies, because both sides need it: the server declares
 *  it on the plans that ask for it (server/domains/runs/defs/ansiwise-run.kit.ts holds it under
 *  ANSIWISE_ELEVATION_SECRET, the name every run kind states it by) and the browser has to know which
 *  requested credential this is in order to say what it is for (web/src/approveFields.ts). A key
 *  spelled twice is a key that can disagree with itself. */
export const MACHINE_PASSWORD_SECRET = "ansiwise-elevation";

export interface OperatorInput {
  /** The name the program declares the answer under. */
  field: string;
  /** The prompt a person reads. It is the whole of what they have to go on, so it says what the
   *  value is FOR. */
  label: string;
}

/** Whether what a person has typed is enough to approve the run.
 *
 * A PURE RULE and not a line inside the form, the same factoring the tailnet offer has: the form
 * renders, this decides, and a test can reach it. What it decides is one thing — every credential
 * the plan asked for carries a value, and so does every answer.
 *
 * EVERY ANSWER, WITH NO BLANK-IS-AN-ANSWER CASE. What an installation has already recorded is read
 * off its cluster map and never listed here, so an input a plan does list is one only a person can
 * state — and a blank in it is an omission rather than an answer. */
export function approveIsComplete(o: {
  requiredSecrets: readonly string[];
  requiredInputs: readonly OperatorInput[];
  secrets: Readonly<Record<string, string>>;
  inputs: Readonly<Record<string, string>>;
}): boolean {
  return o.requiredSecrets.every((key) => (o.secrets[key] ?? "").trim() !== "")
    && o.requiredInputs.every((input) => (o.inputs[input.field] ?? "").trim() !== "");
}
