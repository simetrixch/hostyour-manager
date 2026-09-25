import { useState, type ReactNode } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import { approvePayload, readyToApprove, secretsToSupply } from "../runScreen.ts";
import { secretFieldLabel, secretFieldHint } from "../approveFields.ts";
import { IconLock } from "./icons.tsx";

/** The slave-deployment ceremony: the secrets the PLAN declares, asked for as it declares them, and the
 *  one it does not ask for because the run fetches it itself.
 *
 *  WHICH FIELDS APPEAR IS NOT THIS COMPONENT'S TO KNOW — secretsToSupply reads them off the run, and the
 *  reason that matters is written there. Owns only the values typed into them, which live in memory for
 *  as long as this form is on screen and go out with the approve. */
export function DeploySlaveApproveForm(props: {
  run: RunView;
  onApprove: (payload: Record<string, string>) => void;
  onDelete: () => void;
}): ReactNode {
  const [supplied, setSupplied] = useState<Record<string, string>>({});
  const [stated, setStated] = useState<Record<string, string>>({});
  const { run } = props;
  const asked = secretsToSupply(run);

  return (
    <form
      className="ceremony"
      onSubmit={(e) => {
        e.preventDefault();
        if (!readyToApprove(run, supplied)) return;
        props.onApprove(approvePayload(run, supplied, stated));
      }}
    >
      <div className="ceremony__head">
        <span className="ceremony__icon" aria-hidden="true">
          <IconLock />
        </span>
        <div>
          <h3 className="ceremony__title">Ready to deploy</h3>
          <p className="ceremony__sub">
            {asked.length > 0
              ? "This run drives programs on the machine that need root there, so it asks for what only you can give. Approving starts the steps listed below."
              : "One click — nothing to fill in. Approving starts the steps listed below."}
          </p>
        </div>
      </div>
      {asked.map((key) => (
        <label className="field" key={key}>
          <span className="field__label">{secretFieldLabel(key)}</span>
          <input
            type="password"
            value={supplied[key] ?? ""}
            onChange={(e) => setSupplied((v) => ({ ...v, [key]: e.target.value }))}
            autoComplete="off"
          />
          {secretFieldHint(key) !== null && <span className="field__hint">{secretFieldHint(key)}</span>}
        </label>
      ))}
      {/* WHAT THE PROGRAMS ASK OF A PERSON, and what a blank one means. These are not secrets: the
          certificate authority's mailbox and its directory are read back out of the machine
          afterwards. A blank is dropped at approve and the program's own default decides, or its
          refusal names the answer — which is what happened when this form asked for none of them and
          deploy-cluster stopped at `needs the answer "letsencrypt_email"`. */}
      {run.requiredInputs.map((input) => (
        <label className="field" key={input.field}>
          <span className="field__label">{input.label}</span>
          <input
            type="text"
            value={stated[input.field] ?? ""}
            onChange={(e) => setStated((v) => ({ ...v, [input.field]: e.target.value }))}
            autoComplete="off"
          />
          <span className="field__hint">Not a secret. Left blank, the program's own default decides — or it refuses and names this answer.</span>
        </label>
      ))}
      {asked.length > 0 && (
        <p className="ceremony__note">
          Sent once over TLS and carried with every request this run makes to the machine, for exactly as long as the
          run lasts. It is not sealed into Vault and never written to disk, logs, or the audit trail.
        </p>
      )}
      <p className="ceremony__vault">✓ Repo access — auto-sourced from the platform Vault (GITOPS_REPO_PAT)</p>
      <p className="ceremony__note">
        The read-only repo PAT is fetched from the platform Vault during the run and used once to clone the
        slave&apos;s install branch onto the new machine. It is never stored — not on disk, not in logs, not in the
        audit trail.
      </p>
      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={!readyToApprove(run, supplied)}>
          Approve &amp; deploy
        </button>
        <button type="button" className="btn" onClick={props.onDelete}>
          Delete run
        </button>
      </div>
    </form>
  );
}
