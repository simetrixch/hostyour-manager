/** What a person supplies before a run may start.
 *
 * A run's steps are driven by PROGRAMS on the machine, and those programs declare answers that
 * neither the inventory nor the cluster map can state — the range this machine shares with the
 * others, the mailbox a certificate authority writes to, where a separate disk is mounted. The plan
 * lists them, the approve ceremony asks for them, and each one rides the run under
 * `activation-input:<field>`. They are not secrets and are never sealed; the credentials asked for
 * beside them are, and they travel under their own keys.
 */
export interface OperatorInput {
  /** The name the program declares the answer under. */
  field: string;
  /** The prompt a person reads. It is the whole of what they have to go on, so it says what the
   *  value is FOR and, where a blank is an answer, that a blank is allowed. */
  label: string;
  /** A blank is an ANSWER here, not an omission — the label says so ("blank when it has none") and
   *  the machine reads it that way. The approve ceremony gates its button on the inputs NOT marked,
   *  because gating on one that had just invited a blank left the run impossible to approve. */
  optional?: boolean;
}

/** Whether what a person has typed is enough to approve the run.
 *
 * A PURE RULE and not a line inside the form, the same factoring the tailnet offer has: the form
 * renders, this decides, and a test can reach it. What it decides is one thing — every credential
 * the plan asked for carries a value, and every answer that is not marked optional does too.
 *
 * A BLANK OPTIONAL ANSWER IS COMPLETE. It was not, and the run could then not be approved at all:
 * three of the answers a master's release asks for say "blank when it has none" in their own label,
 * and the button stayed disabled until a value was typed into each of them anyway. */
export function approveIsComplete(o: {
  requiredSecrets: readonly string[];
  requiredInputs: readonly OperatorInput[];
  secrets: Readonly<Record<string, string>>;
  inputs: Readonly<Record<string, string>>;
}): boolean {
  return o.requiredSecrets.every((key) => (o.secrets[key] ?? "").trim() !== "")
    && o.requiredInputs.every((input) => input.optional === true || (o.inputs[input.field] ?? "").trim() !== "");
}
