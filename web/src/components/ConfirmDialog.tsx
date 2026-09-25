import { useEffect, useId, useRef, type ReactNode } from "react";

/** A plain intent-confirm dialog — our own, NEVER window.confirm. Title + blast-radius copy +
 *  Cancel/Confirm. The non-typed sibling of TypeToConfirm, for actions that need an explicit yes
 *  but not a retyped resource name. Accessible: role="dialog" + aria-modal, labelled by its title,
 *  focus lands on Cancel (so a stray Enter never fires a destructive default), Escape and a
 *  backdrop click cancel. Reuses the same .dialog shell as TypeToConfirm — no net-new chrome. */
export function ConfirmDialog(props: {
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
  children: ReactNode; // the copy the operator must read before confirming
}): ReactNode {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // onCancel via a ref so the once-registered Escape listener always calls the latest handler.
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;
  useEffect(() => {
    cancelRef.current?.focus();
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
        <div className="dialog__foot">
          <button type="button" className="btn" ref={cancelRef} onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className={`btn ${props.destructive ? "btn--destructive" : "btn--primary"}`} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
