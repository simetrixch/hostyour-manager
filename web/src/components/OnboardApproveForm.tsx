import { useState, type ReactNode } from "react";
import type { OperatorInput } from "../../../shared/api-types.ts";
import { IconLock } from "./icons.tsx";

/** The onboard approve ceremony: operator-supplied REQUIRED secrets (masked, seeded into the consumer's
 *  Vault entry) and/or NON-secret activation inputs (plaintext — sent with the post-onboard
 *  activation call, never sealed). Owns its own field state and hands `onApprove` the merged payload —
 *  secrets under their `consumer-secret:` keys, inputs under `activation-input:<field>`. Rendered only
 *  when the plan asks for at least one of the two; split out of RunDetail to keep that page lean. */
export function OnboardApproveForm(props: {
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
  const allFilled = requiredSecrets.every((k) => secretVals[k]?.trim()) && requiredInputs.every((i) => inputVals[i.field]?.trim());

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
              ? "This consumer needs operator secrets (seeded into its Vault entry) and post-onboard activation details. Approving supplies both and starts the steps below."
              : hasSecrets
                ? "This consumer declares secrets only you can supply (its manifest lists them as required, no generate). Approving seeds them into the consumer's Vault entry and starts the steps below."
                : "This consumer declares a post-onboard activation. Supply its details below — they are sent with the final activation call once the app is serving, and never stored."}
          </p>
        </div>
      </div>
      {requiredSecrets.map((key) => (
        <label className="field" key={key}>
          <span className="field__label">{key.replace(/^consumer-secret:/, "")}</span>
          <input type="password" value={secretVals[key] ?? ""} onChange={(e) => setSecretVals((s) => ({ ...s, [key]: e.target.value }))} autoComplete="off" />
        </label>
      ))}
      {requiredInputs.map((inp) => (
        <label className="field" key={inp.field}>
          <span className="field__label">{inp.label}</span>
          {/* Plaintext (type=text), never a password field: an activation input is not a secret. */}
          <input type="text" value={inputVals[inp.field] ?? ""} onChange={(e) => setInputVals((s) => ({ ...s, [inp.field]: e.target.value }))} autoComplete="off" />
          <span className="field__hint">Not a secret and not stored — sent with the post-onboard activation call once the app is serving.</span>
        </label>
      ))}
      <p className="ceremony__note">
        {hasSecrets ? "Secrets are sent once over TLS, seeded into the consumer's Vault entry, and discarded from memory — never written to disk, logs, or the audit trail. " : ""}
        Activation details are sent only with the final activation call and are never sealed or persisted.
      </p>
      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={!allFilled}>
          Approve &amp; deploy
        </button>
        <button type="button" className="btn" onClick={props.onDelete}>
          Delete run
        </button>
      </div>
    </form>
  );
}
