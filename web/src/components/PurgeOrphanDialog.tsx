import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { listOnboardTargets, type OnboardTargetView, type PurgeInput } from "../api.ts";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The consumer-name shape (G1: name == namespace == AppProject == pointer). Mirrors the server
 *  PurgeParams.consumerName regex, so the destructive button never arms on a name the run would reject. */
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** Force-remove an ORPHAN by NAME. The problem this solves: an onboard that failed after creating
 *  cluster/Vault artifacts but before writing its inventory row leaves NO consumer in the list — so
 *  there is no row to click "Offboard" on. This dialog takes the identity DIRECTLY (name + cluster;
 *  the stage comes from the chosen cluster, which is exactly one stage) and plans a `purge` run. It is
 *  destructive, so it uses the same type-to-confirm arming as TypeToConfirm — the operator must retype
 *  the exact consumer name before the button enables. Plan-then-approve: confirming opens the Run
 *  screen where the operator approves; nothing on the cluster changes here. Reuses the shared .dialog
 *  shell (ConfirmDialog/TypeToConfirm) — no net-new chrome. */
export function PurgeOrphanDialog(props: {
  onConfirm: (input: PurgeInput) => void;
  onCancel: () => void;
  /** Prefill the name field — a DETECTED row hands its known identity over so
   *  the operator does not retype what the scan already named. The type-to-confirm arming is
   *  unchanged: the retype is the destructive-intent gate, never the identity entry. */
  initialName?: string;
  /** Prefill the cluster selection — same source, same reason. */
  initialClusterId?: string;
}): ReactNode {
  const [targets, setTargets] = useState<OnboardTargetView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(props.initialName ?? "");
  const [clusterId, setClusterId] = useState(props.initialClusterId ?? "");
  const [typed, setTyped] = useState("");
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  // onCancel via a ref so the once-registered Escape listener always calls the latest handler.
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;
  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    listOnboardTargets()
      .then(setTargets)
      .catch((e: unknown) => setLoadError(msg(e)));
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const chosen = targets?.find((t) => t.id === clusterId) ?? null;
  const nameValid = NAME_RE.test(name);
  // Destructive-intent arm: a valid name + a chosen cluster + the retyped name matching exactly.
  const armed = nameValid && chosen !== null && typed === name && name.length > 0;

  function confirm(): void {
    if (!armed || !chosen) return;
    props.onConfirm({ consumerName: name, stage: chosen.stage as PurgeInput["stage"], clusterId: chosen.id });
  }

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId} className="dialog__title">
          Purge / force-remove an orphan
        </h3>
        <div className="dialog__body">
          <p>
            Removes a consumer&apos;s <strong>whole footprint by name</strong> — the GitOps pointer, the ArgoCD Application, the
            isolation AppProject, the namespace (its ServiceClaim, so the <strong>MongoDB user &amp; database are deprovisioned</strong>,
            and its credentials Secret), and <strong>permanently deletes its Vault secrets</strong> (repo PAT + ceremony secrets, every
            version, <strong>NOT recoverable</strong>). Use this for an <strong>orphan</strong>: an onboard that failed before it was
            recorded, so it never appears in the list. Every step is idempotent and fail-soft — safe to re-run.
          </p>

          {loadError && (
            <p role="alert" className="alert alert--danger">
              Could not load clusters: {loadError}
            </p>
          )}

          <label className="field">
            <span className="field__label">Consumer name</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value.trim())}
              placeholder="e.g. example-auth"
              autoComplete="off"
              spellCheck={false}
              aria-label="Consumer name"
            />
            {name.length > 0 && !nameValid && <span className="field__hint">⚠ Not a valid consumer name (lowercase DNS label, ≤ 40 chars).</span>}
          </label>

          <label className="field">
            <span className="field__label">Cluster</span>
            <select value={clusterId} onChange={(e) => setClusterId(e.target.value)} aria-label="Cluster" disabled={!targets}>
              <option value="">{targets ? "Select a cluster…" : "Loading clusters…"}</option>
              {targets?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.domain} · {t.stage}
                </option>
              ))}
            </select>
            {chosen && <span className="field__hint">Stage {chosen.stage} — pointer consumers/{chosen.stage}/…/{name || "<name>"}.yaml, namespace {name || "<name>"}.</span>}
          </label>

          <label className="field">
            <span className="field__label">
              Type <span className="mono">{name || "the consumer name"}</span> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label="Type the consumer name to confirm"
            />
          </label>
        </div>

        <div className="dialog__foot">
          <button type="button" className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--destructive" disabled={!armed} onClick={confirm}>
            Plan purge
          </button>
        </div>
      </div>
    </div>
  );
}
