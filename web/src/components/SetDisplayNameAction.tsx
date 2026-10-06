import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The action-bar button that sets, changes or clears the name the tenant is shown under. One field;
 *  empty shows no name. Confirming only PLANS the run: the plan refuses a name the mail service could
 *  not parse; the run records the name and waits until every member renders it. */
export function SetDisplayNameAction(props: { subdomain: string; displayName: string; senderDomain: string; busy: boolean; onSet: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState(props.displayName);
  const value = next.trim();
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => { setNext(props.displayName); setOpen(true); }}>
        Display name…
      </button>
      {open && (
        <ConfirmDialog
          title={`Display name of tenant "${props.subdomain}"`}
          confirmLabel={value === "" ? "Show no name" : `Show as ${value}`}
          onCancel={() => setOpen(false)}
          onConfirm={() => { setOpen(false); props.onSet(value); }}
        >
          <p>
            <label>
              Name (empty shows none){" "}
              <input className="input" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Acme" maxLength={64} />
            </label>
          </p>
          <p>
            {props.senderDomain
              ? <>The tenant sends as its own domain, {props.senderDomain}, so its mail keeps the bare address.</>
              : <>The tenant&apos;s mail, such as a password reset, then comes from {value || "the bare address"}{value ? " <no-reply@…>" : ""} of the platform domain.</>}{" "}
            Letters, digits, spaces and . - &amp; &apos; only, at most 64 characters.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
