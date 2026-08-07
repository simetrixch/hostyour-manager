import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { inviteTenantAdmin, type TenantInviteAdminResult, type InviteMailOutcome } from "../api.ts";

/** The invite-mail outcome as ONE operator line — replicates the server's activation-result.ts mailLine
 *  so the dialog and the run log never drift. */
function mailLine(m: InviteMailOutcome): string {
  switch (m.status) {
    case "sent":
      return `Invite mail: sent via ${m.transport}`;
    case "failed":
      return `Invite mail: FAILED — ${m.detail ?? "no detail reported"}`;
    case "skipped":
      return `Invite mail: not sent (no mail transport configured)`;
  }
}

/** (Re)send a tenant's first-admin invite — OUR dialog, NEVER window.prompt. Phase 1 collects the admin
 *  email; on success phase 2 shows the one-time activate_url (with Copy) + the mail outcome, mirroring
 *  RunDetail's activation callout. The activate_url lives ONLY in this component's state and is dropped
 *  on close — never persisted. Escape / backdrop / Cancel close; focus lands on the email field. */
export function InviteAdminDialog(props: { tenant: { id: string; subdomain: string }; onClose: () => void }): ReactNode {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TenantInviteAdminResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await inviteTenantAdmin(props.tenant.id, email.trim());
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function copyLink(): void {
    const url = result?.activateUrl;
    if (!url) return;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId} className="dialog__title">
          Invite / resend the first admin — {props.tenant.subdomain}
        </h3>

        {/* Errors surface in BOTH phases: a clipboard-copy failure happens in the RESULT phase, so the
            alert is hoisted above the form/result ternary — a set error is never rendered into a dead branch. */}
        {error && (
          <p role="alert" className="alert alert--danger">
            {error}
          </p>
        )}

        {result === null ? (
          <>
            <div className="dialog__body">
              <p>
                The tenant&rsquo;s example-auth is asked to (re)invite this first administrator. The activation link is shown once here and
                stored nowhere; if an admin was already invited but the mail failed, this re-sends a fresh link.
              </p>
            </div>
            <label className="field">
              <span className="field__label">Admin email</span>
              <input ref={inputRef} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@acme.test" autoComplete="off" />
            </label>
            <div className="dialog__foot">
              <button type="button" className="btn" onClick={props.onClose}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" disabled={busy || !email.trim()} onClick={submit}>
                {busy ? "Sending…" : "Send invite"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dialog__body">
              <p>{result.message}</p>
              {result.activateUrl ? (
                <div className="actionbar">
                  <span className="actionbar__text">
                    <strong>Activation link — shown once, not stored.</strong> Copy it now and hand it to the first administrator: <code>{result.activateUrl}</code>
                  </span>
                  <button type="button" className="btn btn--primary" onClick={copyLink}>
                    {copied ? "Copied ✓" : "Copy link"}
                  </button>
                </div>
              ) : (
                <p>No new activation link was returned.</p>
              )}
              {result.mail && <p>{mailLine(result.mail)}</p>}
            </div>
            <div className="dialog__foot">
              <button type="button" className="btn btn--primary" onClick={props.onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
