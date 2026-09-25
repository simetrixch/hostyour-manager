import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** Skip a run step — our dialog, NEVER window.prompt. The operator picks the step from the run's
 *  OWN steps (no free-typing a name that might not exist) and gives a reason; both are required.
 *  Escape and a backdrop click cancel; focus lands on the step picker. Reuses the .dialog shell. */
export function SkipStepDialog(props: {
  steps: { name: string; title: string }[];
  onSkip: (step: string, reason: string) => void;
  onCancel: () => void;
}): ReactNode {
  const titleId = useId();
  const [step, setStep] = useState(props.steps[0]?.name ?? "");
  const [reason, setReason] = useState("");
  const selRef = useRef<HTMLSelectElement>(null);
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;
  useEffect(() => {
    selRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const armed = step !== "" && reason.trim() !== "";

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId} className="dialog__title">
          Skip a step
        </h3>
        <div className="dialog__body">
          <p>Marking a step skipped lets the run proceed past it. It is recorded in the run log with your reason.</p>
        </div>
        <label className="field">
          <span className="field__label">Step</span>
          <select ref={selRef} value={step} onChange={(e) => setStep(e.target.value)}>
            {props.steps.map((s) => (
              <option key={s.name} value={s.name}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Reason</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
        </label>
        <div className="dialog__foot">
          <button type="button" className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!armed} onClick={() => props.onSkip(step, reason.trim())}>
            Skip step
          </button>
        </div>
      </div>
    </div>
  );
}
