import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A cluster row the target picker offers — the shape both target reads answer
 *  (OnboardTargetView / TenantTargetView). */
export interface RelocationTargetView {
  id: string;
  domain: string;
  stage: string;
  tier: string;
  status: string;
}

/** The target picker of the two relocation run kinds that need one: MOVE takes the unit to a
 *  DIFFERENT active cluster of its own stage, RESTORE rebuilds it on any active cluster of that
 *  stage — its own included (the disaster-recovery case). The choices are filtered to what the run
 *  would accept (same stage, active, and for a move never the current cluster), so the dialog can
 *  only aim where assertMovableTo / the target check would let the plan through. Plan-then-approve:
 *  confirming only PLANS the run and opens the Run screen. Reuses the shared .dialog shell. */
export function RelocationTargetDialog(props: {
  title: string;
  kind: "move" | "restore";
  confirmLabel: string;
  /** The unit's stage — the boundary a relocation never crosses. */
  stage: string;
  /** The unit's current cluster — excluded for a move (source ≠ target). */
  currentClusterId: string;
  loadTargets: () => Promise<RelocationTargetView[]>;
  onConfirm: (targetClusterId: string) => void;
  onCancel: () => void;
  children: ReactNode; // the blast-radius copy the operator must read before confirming
}): ReactNode {
  const [targets, setTargets] = useState<RelocationTargetView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clusterId, setClusterId] = useState("");
  const titleId = useId();
  const selectId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // onCancel via a ref so the once-registered Escape listener always calls the latest handler.
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;
  const loadRef = useRef(props.loadTargets);
  loadRef.current = props.loadTargets;
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    loadRef
      .current()
      .then(setTargets)
      .catch((e: unknown) => setLoadError(msg(e)));
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const admitted = (targets ?? []).filter(
    (t) => t.status === "active" && t.stage === props.stage && (props.kind === "restore" || t.id !== props.currentClusterId),
  );

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId} className="dialog__title">
          {props.title}
        </h3>
        <div className="dialog__body">
          {props.children}
          {loadError && (
            <p role="alert" className="alert alert--danger">
              Could not load the target clusters: {loadError}
            </p>
          )}
          <label className="field" htmlFor={selectId}>
            <span className="field__label">Target cluster ({props.stage} only)</span>
            <select id={selectId} className="field__input" value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
              <option value="">— choose a cluster —</option>
              {admitted.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.domain} · {t.stage} · {t.tier}
                </option>
              ))}
            </select>
          </label>
          {targets !== null && admitted.length === 0 && (
            <p className="note">
              No admissible target: a {props.kind} needs an ACTIVE {props.stage} cluster{props.kind === "move" ? " other than the unit's own" : ""}.
            </p>
          )}
        </div>
        <div className="dialog__foot">
          <button type="button" className="btn" ref={cancelRef} onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={clusterId === ""} onClick={() => props.onConfirm(clusterId)}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
