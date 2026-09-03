import { useState, type FormEvent } from "react";
import type { ServerView } from "../../../shared/api-types.ts";
import { machineIdentityBlock, machineIdentityRefusal, machineIdentityStatement, machineIdentitySubmitLabel } from "../machineIdentity.ts";

// The machine's recorded IDENTITY on its card: which host key this manager has pinned, and the one
// place a person says that the machine was rebuilt and states the key it presents now.
//
// THE FIELD IS THE CEREMONY. A machine whose host key changed is refused by every run before a
// credential is offered to it, and the manager cannot tell a rebuild from somebody else answering at
// the address — so what moves the pin is a specific number the person has to go and read off the
// machine, never a button that accepts whatever the address answers with. A wrong statement moves
// the refusal instead of removing it, and the audit trail carries both numbers and who stated them.
//
// ONE FIELD, TWO ACTS, AND THE NUMBER DECIDES WHICH. A fingerprint that differs from the pin says
// the sshd was rebuilt; the fingerprint already pinned says the person went to the machine and found
// it standing, which forgets the recorded /etc/machine-id alone (web/src/machineIdentity.ts). The
// submit button reads the typed value and says which of the two it will do, because a person may not
// press a button that names the other one.
//
// The typed value is held here rather than on the page, because it is one field belonging to one
// card and it is meant to be discarded: closing the form is what an operator does when the number
// they were about to state turns out to be one they cannot account for.

export function MachineIdentity(props: {
  server: ServerView;
  /** Pins the stated fingerprint and forgets the recorded /etc/machine-id. The page owns the call,
   *  its error line and the refresh, and answers whether the statement landed — a refused one leaves
   *  the field standing with what was typed still in it, which is what a person needs to correct a
   *  number they got wrong. */
  onRestate: (fingerprint: string) => Promise<boolean>;
}) {
  const { server, onRestate } = props;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const block = machineIdentityBlock(server);
  const pinned = block.pinned;
  const refusal = pinned && typed.trim() ? machineIdentityRefusal(typed, server, pinned) : null;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!pinned || refusal) return;
    setBusy(true);
    const stated = await onRestate(typed.trim());
    setBusy(false);
    if (!stated) return;
    setTyped("");
    setOpen(false);
  }

  return (
    <>
      <p className="servercard__reading">{block.line}</p>
      {block.offer && pinned && !open && (
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => setOpen(true)}
            title="Say that this machine was rebuilt and state the host key it presents now. It reaches nothing — the machine presents the stated key on the next run, or that run refuses it again."
          >
            This machine was rebuilt
          </button>
        </div>
      )}
      {block.offer && pinned && open && (
        <form onSubmit={submit}>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Host key this machine presents now</span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="SHA256:…"
                autoComplete="off"
                spellCheck={false}
                required
              />
              <span className="field__hint">{refusal ?? machineIdentityStatement(server, pinned)}</span>
            </label>
          </div>
          <div className="form-foot">
            <span className="actions">
              <button type="submit" className="btn btn--danger" disabled={busy || !typed.trim() || refusal !== null}>
                {busy ? "Stating…" : machineIdentitySubmitLabel(typed, pinned)}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setTyped("");
                  setOpen(false);
                }}
              >
                Cancel
              </button>
            </span>
          </div>
        </form>
      )}
    </>
  );
}
