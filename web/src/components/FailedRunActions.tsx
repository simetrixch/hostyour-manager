import { useState, type ReactNode } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import type { AbortOffer } from "../runScreen.ts";

/** Everything a FAILED run offers: re-enter whatever the failed step needs and retry it, skip that step,
 *  ABORT it, or soft-delete the run. Split out of RunDetail exactly the way OnboardApproveForm is — the
 *  page stays the frame and hands each action back as a callback, the ceremony owns its own fields.
 *
 *  The abort is the load-bearing part. It is NOT "stop this run": it appends the run's registered
 *  compensations as visible cleanup steps and RUNS them, so on a create-tenant it
 *  un-deploys the tenant that run created — the same pointer teardown tenant-offboard performs. It
 *  therefore gets what its sibling "Delete run" in this very bar already had and it did not: a
 *  confirmation that spells the consequence out (our own ConfirmDialog, NEVER a native confirm()). And it
 *  is offered only where `abortOffer` says an abort is safe to offer at all — never on a run whose tenant
 *  is live, and never while that is merely unknown. The verdict is decided in runScreen.ts against the
 *  server-resolved tenant state; this renders it, and states it in the tooltip when it is a refusal, so
 *  the operator reads WHY the control is dead instead of guessing.
 *
 *  WHAT THE ABORT DOES NOT UNDO, and why the confirmation says so out loud. createTenantCleanups builds
 *  the teardown from THIS run's own guid alone (create-tenant-abort.ts abortTeardownTarget), so a
 *  REPLACE is never compensated: by the time the run fails, the replace teardown has
 *  already git-rm'd the OLD same-subdomain tenant's pointer, pruned its fan-out, deleted its AppProject
 *  and flipped its row to offboarded, and nothing in the compensation puts any of that back. An operator
 *  told the cleanup "undoes what the run did" would confirm expecting to be where they started and end up
 *  with the previously serving tenant down and settled. The client cannot condition on it: RunView carries
 *  no params (shared/api-types.ts) — only the plan summary and the step list, both of which NAME the
 *  replaced guid on this very screen. So the limit is stated UNCONDITIONALLY for every create-tenant and
 *  points at those two, rather than derived from step-name prefixes there is no typed contract for. */
export function FailedRunActions(props: {
  run: RunView;
  abort: AbortOffer;
  /** Retry from the failed step. `secrets` carries only the fields the operator actually re-entered. */
  onRetry: (secrets?: Record<string, string>) => void;
  onAbort: () => void;
  onSkip: () => void;
  onDelete: () => void;
}): ReactNode {
  const { run, abort } = props;
  const [secrets, setSecrets] = useState<Record<string, string>>({}); // required-secret re-entry (memory-only)
  const [inputs, setInputs] = useState<Record<string, string>>({}); // activation input re-entry (memory-only)
  const [confirmAbort, setConfirmAbort] = useState(false); // abort confirm (our dialog, never window.confirm)

  /** Merge whatever was re-entered into one retry payload — secrets keep their keys, each activation
   *  input rides `activation-input:<field>`; blank fields are omitted so the run keeps its sealed value. */
  function retry(): void {
    const filled: Record<string, string> = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim()));
    for (const inp of run.requiredInputs) {
      const v = inputs[inp.field]?.trim();
      if (v) filled[`activation-input:${inp.field}`] = v;
    }
    props.onRetry(Object.keys(filled).length > 0 ? filled : undefined);
  }

  return (
    <>
      <div className="actionbar">
        {run.requiredSecrets.map((key) => (
          <input
            key={key}
            className="input"
            type="password"
            placeholder={`Re-enter ${key.replace(/^consumer-secret:/, "")} (if the failed step needs it)`}
            value={secrets[key] ?? ""}
            onChange={(e) => setSecrets((s) => ({ ...s, [key]: e.target.value }))}
            autoComplete="off"
          />
        ))}
        {run.requiredInputs.map((inp) => (
          <input
            key={inp.field}
            className="input"
            type="text"
            placeholder={`Re-enter ${inp.label} (if the failed step needs it)`}
            value={inputs[inp.field] ?? ""}
            onChange={(e) => setInputs((s) => ({ ...s, [inp.field]: e.target.value }))}
            autoComplete="off"
          />
        ))}
        <button type="button" className="btn btn--primary" onClick={retry}>
          Retry from failed step
        </button>
        <button type="button" className="btn" onClick={props.onSkip}>
          Skip…
        </button>
        {abort.offered ? (
          <button type="button" className="btn btn--danger" onClick={() => setConfirmAbort(true)}>
            Abort (cleanup)
          </button>
        ) : (
          // Refused, not hidden: a control that vanished would read as "this run cannot be cleaned up",
          // while the truth is that cleaning it up is the one thing that must not happen here. Same shape
          // the two undeletable-run cases in RunDetail use — a disabled button whose title says why.
          <span title={abort.why}>
            <button type="button" className="btn btn--danger" disabled>
              Abort (cleanup)
            </button>
          </span>
        )}
        <button type="button" className="btn btn--danger" onClick={props.onDelete}>
          Delete run
        </button>
      </div>

      {confirmAbort && abort.offered && (
        <ConfirmDialog
          title="Abort this run and undo what it created?"
          confirmLabel="Abort (cleanup)"
          destructive
          onCancel={() => setConfirmAbort(false)}
          onConfirm={() => {
            setConfirmAbort(false);
            props.onAbort();
          }}
        >
          <p>
            Aborting does not just stop this run. It appends the compensations the run registered as visible cleanup steps and{" "}
            <strong>runs them</strong> — and what they undo is what this run <strong>created</strong>, not everything it did. The run
            settles <strong>cancelled</strong> once every one of them has succeeded; a cleanup that fails leaves the run failed at that
            step, to retry or skip like any other. &ldquo;Retry from failed step&rdquo; and &ldquo;Skip…&rdquo; are the paths that KEEP
            what it built.
          </p>
          {run.kind === "create-tenant" && (
            <>
              {abort.tenant && (
                <p>
                  For this create-tenant that means tenant <span className="mono">{abort.tenant.guid}</span> ({abort.tenant.subdomain})
                  is <strong>un-deployed</strong>: its GitOps pointer is removed, ArgoCD prunes its whole fan-out, its{" "}
                  <span className="mono">{abort.tenant.guid}</span> isolation AppProject is deleted and its inventory row — if it has
                  one — is marked offboarded (kept). Its namespace, its Tenant CR, its Vault path and its Mongo databases are
                  NOT touched; purge is the verb that removes those. A fan-out that will NOT prune stops the cleanup at that step
                  rather than deleting the AppProject and settling the row over workloads that keep serving — tenant-purge is then the
                  remedy.
                </p>
              )}
              <p>
                What an abort does <strong>not</strong> do is put back a tenant this run REPLACED. A create-tenant that found an
                existing tenant on the same subdomain takes that one down before deploying the new one — pointer removed, fan-out
                pruned, isolation AppProject deleted, row marked offboarded — and this cleanup reverses none of it, however far it got.
                The summary above and the &ldquo;Replace …&rdquo; steps in the list below name that tenant when there was one. Its
                namespace, Tenant CR, Vault path and Mongo databases were kept, so nothing of it was destroyed — but nothing
                here re-deploys it either, and a fresh create-tenant on that subdomain mints a NEW guid, so it would not be that
                tenant.
              </p>
            </>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
