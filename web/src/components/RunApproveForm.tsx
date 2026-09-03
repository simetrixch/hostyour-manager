import { useState, type ReactNode } from "react";
import { approveIsComplete, type OperatorInput } from "../../../shared/approve.ts";
import { secretFieldLabel, secretFieldHint } from "../approveFields.ts";
import { IconLock } from "./icons.tsx";

/** What a person supplies before a run may start: CREDENTIALS the machine does not hold (masked —
 *  the password its programs raise their commands to root with, and any write credential a program
 *  asks for) and ANSWERS its programs declare that neither the inventory nor the cluster map can
 *  state (plaintext — an answer is not a secret). Owns its own field state and hands `onApprove` the
 *  merged payload: credentials under their own keys, answers under `activation-input:<field>`.
 *  Rendered only where the plan asks for at least one of the two.
 *
 *  IT SAID "CONSUMER" AND NO RUN THAT REACHES IT IS ONE. Every value in RUN_KIND (shared/enums.ts)
 *  acts on a CLUSTER, and RunDetail is its only caller — so the panel described a Vault seeding that
 *  does not happen to the values typed into it. */
export function RunApproveForm(props: {
  requiredSecrets: string[];
  requiredInputs: OperatorInput[];
  onApprove: (payload: Record<string, string>) => void;
  onDelete: () => void;
}): ReactNode {
  const [secretVals, setSecretVals] = useState<Record<string, string>>({});
  const [inputVals, setInputVals] = useState<Record<string, string>>({});
  const { requiredSecrets, requiredInputs } = props;
  const hasSecrets = requiredSecrets.length > 0;
  const hasInputs = requiredInputs.length > 0;
  const allFilled = approveIsComplete({ requiredSecrets, requiredInputs, secrets: secretVals, inputs: inputVals });

  return (
    <form
      className="ceremony"
      onSubmit={(e) => {
        e.preventDefault();
        if (!allFilled) return;
        // One merged approve payload — secrets keep their keys; each activation input rides
        // `activation-input:<field>` (NON-secret, decoded server-side into the run, never sealed).
        props.onApprove({
          ...secretVals,
          ...Object.fromEntries(requiredInputs.map((i) => [`activation-input:${i.field}`, inputVals[i.field] ?? ""])),
        });
      }}
    >
      <div className="ceremony__head">
        <span className="ceremony__icon" aria-hidden="true">
          <IconLock />
        </span>
        <div>
          <h3 className="ceremony__title">Before you approve</h3>
          <p className="ceremony__sub">
            {hasSecrets && hasInputs
              ? "This run needs two things the machine does not hold: credentials only you can supply, and answers its programs ask of a person. Approving hands over both and starts the steps below."
              : hasSecrets
                ? "This run needs credentials only you can supply — the password every command of this run is raised to root with, and any write credential the machine is asked for. Approving hands them over and starts the steps below."
                : "This run needs answers its programs ask of a person. Supply them below — they ride the run and are never stored."}
          </p>
        </div>
      </div>
      {requiredSecrets.map((key) => (
        <label className="field" key={key}>
          <span className="field__label">{secretFieldLabel(key)}</span>
          <input type="password" value={secretVals[key] ?? ""} onChange={(e) => setSecretVals((s) => ({ ...s, [key]: e.target.value }))} autoComplete="off" />
          {secretFieldHint(key) !== null && <span className="field__hint">{secretFieldHint(key)}</span>}
        </label>
      ))}
      {requiredInputs.map((inp) => (
        <label className="field" key={inp.field}>
          <span className="field__label">{inp.label}</span>
          {/* Plaintext (type=text), never a password field: an activation input is not a secret. */}
          <input type="text" value={inputVals[inp.field] ?? ""} onChange={(e) => setInputVals((s) => ({ ...s, [inp.field]: e.target.value }))} autoComplete="off" />
          <span className="field__hint">{inp.optional === true ? "Optional — a blank is the answer here, and the machine reads it as \"this cluster has none\"." : "Not a secret and not stored — it rides the run and reaches the program that declares it."}</span>
        </label>
      ))}
      <p className="ceremony__note">
        {hasSecrets ? "Credentials are sent once over TLS, held in memory for the length of the run, and sent with each request the run makes — never written to disk, to a log, or to the audit trail. " : ""}
        The answers above are not secrets: they ride the run and are never sealed or persisted.
      </p>
      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={!allFilled}>
          Approve and start
        </button>
        <button type="button" className="btn" onClick={props.onDelete}>
          Delete run
        </button>
      </div>
    </form>
  );
}
