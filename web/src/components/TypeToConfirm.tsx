import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** A destructive-intent dialog that tests REAL intent: the operator must retype the exact `expected`
 *  token (the resource's own name) before the armed action enables — the arming mechanics from
 *  ResetWizard ("type RESET to arm"), keyed to the resource name instead of a fixed keyword, so a
 *  stray click can never fire the teardown. This is the modal sibling of TenantDetail's typed-guid
 *  confirm; both lifecycle families thus test intent the same way.
 *
 *  Accessible: role="dialog" + aria-modal, labelled by its title, focus lands on the input, Escape
 *  and a backdrop click cancel. There is no shared Modal in the codebase, so the overlay chrome is
 *  the one net-new piece and is kept minimal. */
export function TypeToConfirm(props: {
  title: string;
  expected: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode; // the blast-radius copy the operator must read
}): ReactNode {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const armed = typed === props.expected;

  // onCancel via a ref so the once-registered Escape listener always calls the latest handler
  // without re-binding on every render (props is a fresh object each render).
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId} className="dialog__title">
          {props.title}
        </h3>
        <div className="dialog__body">{props.children}</div>
        <label className="field">
          <span className="field__label">
            Type <span className="mono">{props.expected}</span> to confirm
          </span>
          <input
            ref={inputRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${props.expected} to confirm`}
          />
        </label>
        <div className="dialog__foot">
          <button type="button" className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--destructive" disabled={!armed} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
