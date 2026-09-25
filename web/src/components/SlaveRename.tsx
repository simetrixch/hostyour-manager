import { useEffect, useState, type FormEvent } from "react";
import type { ServerView } from "../../../shared/api-types.ts";
import type { ServerReachView } from "../../../shared/api-types-reach.ts";
import { readServerReach } from "../api.ts";

// A live slave's REACH and its RENAME, on its card.
//
// THE READING COMES FIRST. Whether this manager reaches the machine at the host its row names is
// measured when the card is shown: a machine that moved to another FQDN answers nothing there, and
// the card says so in red with the reason — the name that does not resolve, the port that refuses,
// the silence. That is the error a person sees before any run of the machine fails on it.
//
// AND THE WAY OUT STANDS BESIDE IT. The rename moves the slave onto the FQDN it answers at now and
// adopts it there; its name, its ArgoCD instance and every unit on it stay as they are. Where the
// machine is out of reach the form is open at once, because that is the one thing to do with the
// card; where it is reached, the rename is a button like the card's other acts. What the rename
// does, and what it refuses, the run's approve screen states in full.

export function SlaveRename(props: {
  server: ServerView;
  /** The FQDN the slave's cluster stands at now — what the rename is asked FROM. */
  fromFqdn: string;
  /** Plans the rename. The page owns the call, its error line and the navigation to the run. */
  onRename: (newFqdn: string) => Promise<void>;
}) {
  const { server, fromFqdn, onRename } = props;
  const [reach, setReach] = useState<ServerReachView | null>(null);
  const [readFailed, setReadFailed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    readServerReach(server.id)
      .then((r) => {
        if (!live) return;
        setReach(r);
        if (!r.reachable) setOpen(true);
      })
      .catch((err: unknown) => live && setReadFailed(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [server.id]);

  const newFqdn = typed.trim().toLowerCase();
  const askable = newFqdn.length > 0 && newFqdn !== fromFqdn;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!askable) return;
    setBusy(true);
    await onRename(newFqdn);
    setBusy(false);
  }

  return (
    <>
      {reach === null && readFailed === null && <p className="servercard__reading">Checking whether this manager reaches {server.host}…</p>}
      {readFailed !== null && <p className="servercard__reading">Whether {server.host} answers could not be read: {readFailed}</p>}
      {reach?.reachable === true && <p className="servercard__reading">Reached at {reach.host}:{reach.port}.</p>}
      {reach?.reachable === false && (
        <p role="alert" className="alert alert--danger">
          Not reachable at {reach.host}:{reach.port} — {reach.reason}. If the machine answers at another FQDN now, rename the slave to it
          below: its name and every unit on it stay as they are.
        </p>
      )}
      {!open && (
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => setOpen(true)}
            title="Move this slave onto the FQDN it answers at now and adopt it there. Its name, its ArgoCD instance and every unit on it stay; the approve screen states what moves."
          >
            Rename
          </button>
        </div>
      )}
      {open && (
        <form onSubmit={(e) => void submit(e)}>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">New FQDN of {server.name} (now {fromFqdn})</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="the FQDN the machine answers at now" autoComplete="off" />
            </label>
          </div>
          <div className="form-foot">
            <span className="field__hint">It must resolve to the machine before you approve; the machine must show the host key this manager holds for it.</span>
            <span className="page__actions">
              <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn--primary" disabled={busy || !askable}>
                {busy ? "Planning…" : "Plan the rename"}
              </button>
            </span>
          </div>
        </form>
      )}
    </>
  );
}
