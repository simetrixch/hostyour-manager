import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { OperatorKeyView, ServerView } from "../../../shared/api-types.ts";
import {
  listOperatorKeys, createOperatorKey, deleteOperatorKey, listServers, placeOperatorKey, removeOperatorKey,
} from "../api.ts";
import { OPERATOR_MARKER_PREFIX } from "../../../shared/operator-keys.ts";
import { OPERATOR_KEY_RUN_KINDS } from "../runKinds.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { OperatorKeyCard } from "../components/OperatorKeyCard.tsx";
import { SectionRuns } from "../components/SectionRuns.tsx";
import { IconShield } from "../components/icons.tsx";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const EMPTY = { label: "", publicKey: "" };

/**
 * A human operator's own SSH key, and which machines carry it.
 *
 * This manager holds only the PUBLIC line — the private half never leaves the person whose key
 * it is — plus the label the key is placed and removed under. The label is not decoration: it is
 * written into every host's authorized_keys as the comment `hostyour-operator:<label>`, and a
 * removal deletes by exactly that comment, which is what keeps it away from the line this
 * manager uses to reach the machine at all.
 */
export function OperatorKeys() {
  const nav = useNavigate();
  const [keys, setKeys] = useState<OperatorKeyView[] | null>(null);
  const [servers, setServers] = useState<ServerView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  // Bumped on a successful add to REMOUNT the form: React-controlled inputs keep their browser
  // :user-invalid state after a submit, so the freshly-emptied required fields would render red.
  const [formKey, setFormKey] = useState(0);
  const [forgetTarget, setForgetTarget] = useState<OperatorKeyView | null>(null);

  function refresh(): void {
    listOperatorKeys()
      .then((r) => setKeys(r.keys))
      .catch((e: unknown) => setError(msg(e)));
    listServers()
      .then((r) => setServers(r.servers))
      .catch((e: unknown) => setError(msg(e)));
  }
  useEffect(refresh, []);

  async function add(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createOperatorKey({ label: form.label.trim(), publicKey: form.publicKey.trim() });
      setForm({ ...EMPTY });
      setFormKey((k) => k + 1);
      refresh();
    } catch (err) {
      setError(msg(err));
    }
    setBusy(false);
  }

  /** Plan one of the two acts and hand off to its Run screen — the operator approves there, sees
   *  both readings in the log, and comes back to a card the run has just rewritten. */
  async function plan(run: () => Promise<{ runId: string }>): Promise<void> {
    setError(null);
    try {
      const { runId } = await run();
      nav(`/runs/${runId}`);
    } catch (err) {
      setError(msg(err));
    }
  }

  async function forget(id: string): Promise<void> {
    setError(null);
    try {
      await deleteOperatorKey(id);
      refresh();
    } catch (err) {
      setError(msg(err));
    }
  }

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">Operator keys</h2>
          <p className="page__desc">Human SSH keys this manager can place on the servers and take off again.</p>
        </div>
        <div className="page__actions">
          <Link className="btn" to="/servers">
            Servers
          </Link>
        </div>
      </header>

      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}

      <form key={formKey} className="card" onSubmit={add}>
        <h3 className="form-card__title">Add an operator key</h3>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Label</span>
            <input value={form.label} onChange={(e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="pat" pattern="[a-z0-9][a-z0-9-]*" required />
          </label>
          <label className="field">
            <span className="field__label">Public key</span>
            <textarea rows={3} value={form.publicKey}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setForm((f) => ({ ...f, publicKey: e.target.value }))}
              placeholder="ssh-ed25519 AAAAC3Nz… pat@example.com" required />
          </label>
        </div>
        <div className="form-foot">
          <span className="field__hint">
            One line, as it stands in the person&apos;s own <code>.pub</code> file. Their comment is dropped: the comment on the
            placed line is the marker <code>{OPERATOR_MARKER_PREFIX}&lt;label&gt;</code>, and the label is what a removal matches —
            so it takes lowercase letters, digits and hyphens and nothing else.
          </span>
          <button type="submit" className="btn btn--primary" disabled={busy || !form.label || !form.publicKey}>
            {busy ? "Adding…" : "Add key"}
          </button>
        </div>
      </form>

      {!keys ? (
        <div className="loading">
          <span className="spinner" aria-hidden="true" />
          Loading operator keys…
        </div>
      ) : keys.length === 0 ? (
        <div className="empty">
          <p>No operator keys yet — add one above.</p>
        </div>
      ) : (
        <ul className="cards">
          {keys.map((k) => (
            <OperatorKeyCard
              key={k.id}
              entry={k}
              servers={servers}
              onPlace={(serverId) => void plan(() => placeOperatorKey(serverId, k.id))}
              onRemove={(serverId) => void plan(() => removeOperatorKey(serverId, k.id))}
              onForget={() => setForgetTarget(k)}
            />
          ))}
        </ul>
      )}

      <h3 className="form-card__title">Runs</h3>
      <SectionRuns kinds={OPERATOR_KEY_RUN_KINDS} empty="No key has been placed, removed or read yet." />

      <p className="note">
        <IconShield />
        <span>
          What each server carries is what its LAST reading found — a snapshot one run took, never a live probe. Read a server
          again from its card on Servers; a key that appeared while nobody was placing anything shows up there as foreign, which
          means no run kind here can remove it.
        </span>
      </p>

      {forgetTarget && (
        <ConfirmDialog
          title={`Forget the operator key "${forgetTarget.label}"?`}
          confirmLabel="Forget it"
          destructive
          onCancel={() => setForgetTarget(null)}
          onConfirm={() => {
            const t = forgetTarget;
            setForgetTarget(null);
            void forget(t.id);
          }}
        >
          <p>
            This takes the key off NO machine. It is refused while the last reading of any server still finds it, because the
            removal run needs this row to name the line it deletes.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
