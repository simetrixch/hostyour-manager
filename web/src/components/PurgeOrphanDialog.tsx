import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { listOnboardTargets, type OnboardTargetView, type PurgeInput } from "../api.ts";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The consumer-name shape (G1: name == chart == repo == registration directory). Mirrors the server
 *  PurgeParams.consumerName regex, so the destructive button never arms on a name the run would reject. */
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** Force-remove an ORPHAN by IDENTITY. The problem this solves: an onboard that failed after creating
 *  cluster/Vault artifacts but before writing its inventory row leaves NO consumer in the list — so
 *  there is no row to click "Offboard" on. This dialog takes the identity DIRECTLY (name + stage +
 *  cluster: the namespace is `<name>-<stage>`, and the cluster is whichever active one holds it) and
 *  plans a `purge` run. It is destructive, so it uses the same type-to-confirm arming as
 *  TypeToConfirm — the operator must retype the exact consumer name before the button enables.
 *  Plan-then-approve: confirming opens the Run screen where the operator approves; nothing on the
 *  cluster changes here. Reuses the shared .dialog shell (ConfirmDialog/TypeToConfirm) — no net-new
 *  chrome. */
export function PurgeOrphanDialog(props: {
  onConfirm: (input: PurgeInput) => void;
  onCancel: () => void;
  /** Prefill the identity — a DETECTED row hands its known name, stage and cluster over so the
   *  operator does not retype what the scan already named ({} from the header button). The
   *  type-to-confirm arming is unchanged: the retype is the destructive-intent gate, never the
   *  identity entry. */
  initial: { name?: string; stage?: Stage; clusterId?: string };
}): ReactNode {
  const [targets, setTargets] = useState<OnboardTargetView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(props.initial.name ?? "");
  const [stage, setStage] = useState<string>(props.initial.stage ?? "");
  const [clusterId, setClusterId] = useState(props.initial.clusterId ?? "");
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
  const stageValid = (STAGE as readonly string[]).includes(stage);
  // Destructive-intent arm: a valid name + a stage + a chosen cluster + the retyped name matching exactly.
  const armed = nameValid && stageValid && chosen !== null && typed === name && name.length > 0;

  function confirm(): void {
    if (!armed || !chosen) return;
    props.onConfirm({ consumerName: name, stage: stage as Stage, clusterId: chosen.id });
  }

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId} className="dialog__title">
          Purge / force-remove an orphan
        </h3>
        <div className="dialog__body">
          <p>
            Removes a consumer&apos;s <strong>whole footprint at one stage</strong> — the GitOps registration, the ArgoCD Application,
            the isolation AppProject, the namespace (its ServiceClaim, so the <strong>MongoDB user &amp; database are deprovisioned</strong>,
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
            <span className="field__label">Stage</span>
            <select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Stage">
              <option value="">Select a stage…</option>
              {STAGE.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Cluster</span>
            <select value={clusterId} onChange={(e) => setClusterId(e.target.value)} aria-label="Cluster" disabled={!targets}>
              <option value="">{targets ? "Select a cluster…" : "Loading clusters…"}</option>
              {targets?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.domain} (platform {t.stage})
                </option>
              ))}
            </select>
            {chosen && stageValid && (
              <span className="field__hint">
                Namespace {name || "<name>"}-{stage} on {chosen.domain} — registration registrations/{name || "<name>"}/{stage}.yaml.
              </span>
            )}
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
