import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { RunView, RunEventView, RunTenantStateView } from "../../../shared/api-types.ts";
import { ACTIVATION_RESULT_MARKER } from "../../../shared/api-types.ts";
import { getRun, approveRun, deleteRun, cancelRun, retryRun, skipRun, abortRun, getRunTenantState } from "../api.ts";
import { abortOffer, runOnScreen } from "../runScreen.ts";
import { IconLock } from "../components/icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { SkipStepDialog } from "../components/SkipStepDialog.tsx";
import { RunApproveForm } from "../components/RunApproveForm.tsx";
import { DeploySlaveApproveForm } from "../components/DeploySlaveApproveForm.tsx";
import { FailedRunActions } from "../components/FailedRunActions.tsx";
import { FailedCreateTenantCallout } from "../components/FailedCreateTenantCallout.tsx";
import { AnsiText, stripAnsi } from "../components/AnsiText.tsx";

// "ephemeral" is the live-only stream: the server publishes it to this SSE stream and never writes
// an events row, so such a line (the activate_url) exists only while this screen stays open.
const STREAMS = ["stdout", "stderr", "meta", "ephemeral"];

/** Presentation only: meta lines from the executor are prefixed ▶/✓/✗ (✕ when cancelled) —
 *  colour them like a real terminal would. */
function lineClass(l: RunEventView): string {
  if (l.stream === "meta") {
    const c = l.text.charAt(0);
    if (c === "✓") return "log__line log__line--meta log__line--ok";
    if (c === "✗" || c === "✕") return "log__line log__line--meta log__line--err";
    return "log__line log__line--meta";
  }
  return l.stream === "stderr" ? "log__line log__line--stderr" : "log__line";
}

export function RunDetail() {
  const { id } = useParams();
  const runId = id ?? "";
  const [loaded, setLoaded] = useState<RunView | null>(null); // what the last GET returned — see `run` below
  const [lines, setLines] = useState<RunEventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState(""); // adopt credential ceremony (memory-only)
  const [confirmDelete, setConfirmDelete] = useState(false); // delete-run confirm (our dialog, never window.confirm)
  const [showSkip, setShowSkip] = useState(false); // skip-step dialog (our dialog, never window.prompt)
  // What the tenant a FAILED create-tenant minted IS right now, resolved SERVER-SIDE from the tenants row
  //. Held HERE rather than inside the callout that shows it, because TWO things on
  // this screen hang off the answer — the callout's words AND whether the action bar may offer
  // "Abort (cleanup)" at all, an abort being the full un-deploy of that tenant. One read, one answer.
  const [tenant, setTenant] = useState<RunTenantStateView | null>(null);
  const [tenantError, setTenantError] = useState<string | null>(null); // the LOOKUP failure, not a failed purge plan
  const [copied, setCopied] = useState(false); // "Copy all" transient feedback
  const [copiedUrl, setCopiedUrl] = useState(false); // activate_url copy transient feedback
  const logRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true); // follow the tail unless the operator scrolled up
  const navigate = useNavigate();

  // The run this screen may describe AND act on — never a run the address bar has already left behind.
  const run = runOnScreen(loaded, runId);
  // Whether the tenant question is worth asking at all. ONE flag for both the GET below and the callout
  // that renders its answer, so the fetch condition and the render condition can never drift apart.
  const asksTenantState = run !== null && run.deletedAt === null && run.status === "failed" && run.kind === "tenant-create";

  function refresh() {
    getRun(runId)
      .then(setLoaded)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    if (!runId) return;
    // The log is dropped for the new id. This screen can now navigate straight to ANOTHER run (a failed
    // create-tenant hands off to the tenant-purge it plans), which re-uses this component — without the
    // reset the new run's header would sit above the previous run's log. The run OBJECT needs no reset:
    // `run` is derived from the id, so a stale one cannot render (runScreen.ts).
    setLines([]);
    refresh();
    const es = new EventSource(`/api/runs/${runId}/events`);
    const onEvent = (e: Event) => {
      const ev = JSON.parse((e as MessageEvent).data as string) as RunEventView;
      setLines((prev) => [...prev, ev]);
      if (ev.stream === "meta") refresh(); // a meta line means the run status likely moved
    };
    for (const s of STREAMS) es.addEventListener(s, onEvent);
    es.onerror = () => es.close(); // the server closes the stream once the run is terminal
    return () => es.close();
  }, [runId]);

  useEffect(() => {
    // Drop any earlier answer FIRST. A retry that failed again asks the SAME question at a later moment —
    // record-inventory may have settled the tenant to "active" in between — so neither the abort gate nor
    // the callout may fall back on the state that was read before that retry.
    setTenant(null);
    setTenantError(null);
    if (!asksTenantState) return;
    let alive = true;
    getRunTenantState(runId)
      .then((t) => {
        if (alive) setTenant(t);
      })
      .catch((e: unknown) => {
        if (alive) setTenantError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [runId, asksTenantState]);

  useEffect(() => {
    const el = logRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function onLogScroll() {
    const el = logRef.current;
    if (el) followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  function act(fn: () => Promise<unknown>) {
    fn()
      .then(refresh)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  /** Soft-delete this run ("Delete run" on a planned, failed, or cancelled run): it
   *  disappears from the runs list — honestly deleted from the operator's view — while the
   *  row and its complete log stay in the audit DB for retroactive inspection. Navigate
   *  back to the list, where the run is now gone. */
  // "Delete run" opens our ConfirmDialog (never window.confirm); doDelete performs the soft-delete.
  function doDelete() {
    deleteRun(runId)
      // The global /runs list no longer exists and RunDetail is shared across
      // consumers/servers/tenants — go back to whichever section opened this run.
      .then(() => navigate(-1))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  if (error)
    return (
      <p role="alert" className="alert alert--danger">
        {error}
      </p>
    );
  if (!run)
    return (
      <div className="loading">
        <span className="spinner" aria-hidden="true" />
        Loading run…
      </div>
    );

  // "Copy all" — the WHOLE run as plain text (header + summary + every step + the full
  // log), so a failing run can be shared in one click instead of hand-selecting the log.
  function copyReport(): void {
    if (!run) return;
    const text = [
      `Run: ${run.kind}  [${run.status}]${run.deletedAt !== null ? "  (deleted)" : ""}`,
      `id: ${run.id}`,
      ...(run.summary ? [`summary: ${run.summary}`] : []),
      "",
      "--- Steps ---",
      ...run.steps.map((s) => `- ${s.title}: ${s.status}`),
      "",
      `--- Log (${lines.length} ${lines.length === 1 ? "line" : "lines"}) ---`,
      ...lines.map((l) => `${l.seq}\t${stripAnsi(l.text)}`),
    ].join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  // the onboard `activate` step surfaces the returned activate_url in ONE live-only (ephemeral) line,
  // prefixed with the shared ACTIVATION_RESULT_MARKER. Lift it into a copyable callout: the URL is a
  // one-time root-admin credential shown once and stored nowhere — it never lands in the events table,
  // so it survives neither a reload nor a reconnect, and the operator must grab it before leaving the
  // screen. Scan newest-first so a re-run's line wins.
  const activateUrl = ((): string | null => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = lines[i]?.text ?? "";
      const idx = text.indexOf(ACTIVATION_RESULT_MARKER);
      if (idx >= 0) {
        const m = text.slice(idx + ACTIVATION_RESULT_MARKER.length).match(/https?:\/\/\S+/);
        if (m) return m[0];
      }
    }
    return null;
  })();

  function copyActivateUrl(): void {
    if (!activateUrl) return;
    navigator.clipboard
      .writeText(activateUrl)
      .then(() => {
        setCopiedUrl(true);
        window.setTimeout(() => setCopiedUrl(false), 1500);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  return (
    <section className="page page--run">
      <header className="runhead">
        <div className="runhead__row">
          <h2 className="runhead__title">{run.kind}</h2>
          <span className={`badge badge--${run.status}`}>{run.status}</span>
          {run.deletedAt !== null && <span className="badge badge--cancelled">deleted</span>}
          <span className="runhead__id">{run.id}</span>
        </div>
        {run.summary && <p className="runhead__summary">{run.summary}</p>}
      </header>

      {run.deletedAt !== null && (
        <div className="actionbar">
          <span className="actionbar__text">
            This run was deleted — it no longer appears in the runs list. Its full log stays in the audit DB and remains
            readable below.
          </span>
        </div>
      )}

      {run.deletedAt === null && run.status === "planned" && run.kind === "cluster-deploy-slave" && (
        <DeploySlaveApproveForm
          run={run}
          onApprove={(payload) => act(() => approveRun(runId, payload))}
          onDelete={() => setConfirmDelete(true)}
        />
      )}

      {run.deletedAt === null &&
        run.status === "planned" &&
        run.kind !== "cluster-deploy-slave" &&
        (run.kind === "cluster-adopt" ? (
          <form
            className="ceremony"
            onSubmit={(e) => {
              e.preventDefault();
              if (password) act(() => approveRun(runId, { "adopt-password": password }));
            }}
          >
            <div className="ceremony__head">
              <span className="ceremony__icon" aria-hidden="true">
                <IconLock />
              </span>
              <div>
                <h3 className="ceremony__title">Credential ceremony</h3>
                <p className="ceremony__sub">One password, one connection, one installed key.</p>
              </div>
            </div>
            <label className="field">
              <span className="field__label">One-time password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </label>
            <p className="ceremony__note">
              Used once to install an SSH key and never stored. After the key is verified the password is discarded from
              memory — it is never written to disk, logs, or the audit trail.
            </p>
            <div className="actions">
              <button type="submit" className="btn btn--primary" disabled={!password}>
                Approve &amp; adopt
              </button>
              <button type="button" className="btn" onClick={() => setConfirmDelete(true)}>
                Delete run
              </button>
            </div>
          </form>
        ) : run.requiredSecrets.length > 0 || run.requiredInputs.length > 0 ? (
          <RunApproveForm
            requiredSecrets={run.requiredSecrets}
            requiredInputs={run.requiredInputs}
            onApprove={(payload) => act(() => approveRun(runId, payload))}
            onDelete={() => setConfirmDelete(true)}
          />
        ) : (
          <div className="actionbar">
            <span className="actionbar__text">This plan is waiting for your approval — approving starts the steps listed below.</span>
            <button type="button" className="btn btn--primary" onClick={() => act(() => approveRun(runId))}>
              Approve
            </button>
            <button type="button" className="btn" onClick={() => setConfirmDelete(true)}>
              Delete run
            </button>
          </div>
        ))}

      {run.status === "running" && (
        <div className="actionbar">
          <span className="actionbar__text">The run is executing.</span>
          <button type="button" className="btn" onClick={() => act(() => cancelRun(runId))}>
            Cancel
          </button>
          <span title="A run in progress can't be deleted — cancel it first.">
            <button type="button" className="btn" disabled>
              Delete run
            </button>
          </span>
        </div>
      )}

      {/* The whole failed-run ceremony (retry / skip / abort / delete) lives in its own component, like the
          approve ceremony above. `abort` is the gate on abort-with-cleanup: on a create-tenant an abort
          UN-DEPLOYS the tenant the run created, so it is decided against the server-resolved tenant state
          rather than against "the run failed" — runScreen.ts spells out why. */}
      {run.deletedAt === null && run.status === "failed" && (
        <FailedRunActions
          run={run}
          abort={abortOffer(run.kind, tenant, tenantError)}
          onRetry={(secrets) => act(() => retryRun(runId, undefined, secrets))}
          onAbort={(secrets) => act(() => abortRun(runId, secrets))}
          onSkip={() => setShowSkip(true)}
          onDelete={() => setConfirmDelete(true)}
        />
      )}

      {/* What the failed create-tenant left behind — a tenant with no inventory row
          that nothing else in the product can remove, a half-created one, or (when only the final invite
          failed) a tenant that is perfectly live. Kind+status only decide whether the QUESTION is worth
          asking; the ANSWER comes from the tenants row, server-side, so this screen never claims a state
          it did not read. Rendered only while the run is still actionable (a deleted run is out of the
          operator's view), and keyed on runId so a hop to another run never leaves this one's purge
          dialog standing. */}
      {asksTenantState && <FailedCreateTenantCallout key={runId} tenant={tenant} error={tenantError} />}

      {run.deletedAt === null && run.status === "cancelled" && (
        <div className="actionbar">
          <span className="actionbar__text">This run was cancelled — nothing more will happen.</span>
          <button type="button" className="btn btn--danger" onClick={() => setConfirmDelete(true)}>
            Delete run
          </button>
        </div>
      )}

      {run.deletedAt === null && run.status === "succeeded" && (
        <div className="actionbar">
          {/* DELETING HIDES THE RUN AND TEARS NOTHING DOWN, which is what the executor states and
              what this bar used to deny: a soft-deleted succeeded run keeps its inventory row and
              its git pointer, so what it built goes on running, and its whole log stays readable in
              the audit database (executor/executor.ts, deleteRun). Removing a thing is the separate
              offboard or remove run and never a side effect of tidying a list.

              IT WAS REFUSED HERE AND ALLOWED THERE, and what that cost was a machine nobody could
              adopt again: apps4 was restored, the key its adopt had installed went with the
              snapshot, and the run that recorded the adopt stood in the way of recording a new one
              (2026-08-29). */}
          <span className="actionbar__text">
            This run finished. Deleting it hides it from the list — what it built keeps running, and its log stays in the audit
            database.
          </span>
          <button type="button" className="btn btn--danger" onClick={() => setConfirmDelete(true)}>
            Delete run
          </button>
        </div>
      )}

      {activateUrl && (
        <div className="actionbar">
          <span className="actionbar__text">
            <strong>Activation link — shown once, not stored.</strong> The activation step returned a one-time root-admin URL; it is saved nowhere on the platform. Copy it now and hand it to the first administrator: <code>{activateUrl}</code>
          </span>
          <button type="button" className="btn btn--primary" onClick={copyActivateUrl}>
            {copiedUrl ? "Copied ✓" : "Copy link"}
          </button>
        </div>
      )}

      <div className="run-body">
        <div className="steps-panel">
          <h3 className="steps-panel__title">Steps</h3>
          <ol className="steps">
            {run.steps.map((s) => (
              <li key={s.name} className={`step step--${s.status}`}>
                <span className="step__marker" aria-hidden="true" />
                <div className="step__body">
                  <span className="step__title">{s.title}</span>
                  <span className="step__status">{s.status}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="log-panel">
          <div className="log-panel__head">
            <h3 className="log-panel__title">Live log</h3>
            <span className="log-panel__count">
              {lines.length} {lines.length === 1 ? "line" : "lines"}
            </span>
            <button
              type="button"
              className="btn"
              style={{ marginInlineStart: "auto" }}
              onClick={copyReport}
              title="Copy the whole run — header, steps and the full log — to the clipboard"
            >
              {copied ? "Copied ✓" : "Copy all"}
            </button>
          </div>
          <pre className="log" data-testid="run-log" ref={logRef} onScroll={onLogScroll}>
            {lines.length === 0 && <div className="log__idle">Waiting for output…</div>}
            {lines.map((l) => (
              <div key={l.seq} className={lineClass(l)}>
                <span className="log__seq">{l.seq}</span>
                <span className="log__text"><AnsiText text={l.text} /></span>
              </div>
            ))}
          </pre>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this run?"
          confirmLabel="Delete run"
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            doDelete();
          }}
        >
          <p>It disappears from the section&apos;s runs list. Its row and full log stay in the audit DB and remain readable by id.</p>
        </ConfirmDialog>
      )}
      {showSkip && (
        <SkipStepDialog
          steps={run.steps.filter((s) => s.status === "failed")}
          onCancel={() => setShowSkip(false)}
          onSkip={(step, reason) => {
            setShowSkip(false);
            act(() => skipRun(runId, step, reason));
          }}
        />
      )}
    </section>
  );
}
