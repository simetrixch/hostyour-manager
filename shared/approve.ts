import type { PreflightCheck } from "./preflight.ts";

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

/** The approve-time PAT of one build unit a tenant onboarding registers on the way (hostyour-manager#165):
 *  `build-repo-pat:<unit>`, one per repository the installation has not registered yet. Asked once —
 *  the run seals it, registers the unit and seeds it into the build plane; the next tenant asks for
 *  nothing. Shared by the plan that demands it and the approve card that labels it. */
export interface OperatorInput {
  /** The name the program declares the answer under. */
  field: string;
  /** The prompt a person reads. It is the whole of what they have to go on, so it says what the
   *  value is FOR. */
  label: string;
}

/** What a run's view carries about its approve: what a person supplies, and what was measured before
 *  they are asked (RunView extends this, shared/api-types.ts). */
/** What a run's view carries about ONE asked secret beyond its key: the sentence its declaration
 *  gives it. For a consumer's own secret that is the `description` of its `secrets[]` entry in the
 *  manifest (#244) — the only place that says what the value IS, which key names never can
 *  ("SMTP_URL" does not say that a user, a password, a host and a port ride in one URL). Absent for
 *  a key whose declaration carries none. */
export type SecretHints = Record<string, string>;

export interface RunApproveView {
  /** The plan's operator-supplied secret keys (executor `requiredSecrets`). The approve
   *  ceremony renders one input per entry and passes them to /approve; empty for most runs
   *  (e.g. an onboard whose manifest secrets are all `generate:`). */
  requiredSecrets: string[];
  /** The plan's secret keys a person MAY supply (executor `optionalSecrets`): rendered as optional
   *  fields, never gating the approve; a value given rides the run like a required one. */
  optionalSecrets: string[];
  /** What the steps' probes measured before the approve (executor `findings`, hostyour-manager#207),
   *  in step order: every finding, passed or not — a plan standing `planned` carries no hard
   *  failure, since one refuses the plan. Rendered as a table above the approve ceremony. */
  findings: PreflightCheck[];
  /** The plan's operator-supplied NON-secret inputs (onboard activation prompts). Empty for
   *  every run whose consumer declares no `activation:` block. Rendered as plaintext fields in the
   *  approve ceremony and carried in the approve payload under `activation-input:<field>` keys. */
  requiredInputs: OperatorInput[];
  /** Per secret key, the sentence its declaration gives it (#244). A key the plan said nothing
   *  about is absent, and the form then shows the key alone, as before. */
  secretHints: SecretHints;
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
