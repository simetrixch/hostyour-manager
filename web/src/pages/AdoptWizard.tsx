import { useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { createServer, planRun } from "../api.ts";

/** Adopt wizard step 1: "where is the machine?". Creates the bare
 *  server, plans the adopt Run, then hands off to the Run screen for the credential ceremony. */
export function AdoptWizard() {
  const nav = useNavigate();
  // sshUser defaults to "" (not "root"): hardened boxes disable root SSH; the operator names
  // the real non-root sudo user (the ceremony escalates via `sudo -S`). Placeholder hints it.
  const [form, setForm] = useState({ name: "", host: "", sshUser: "", sshPort: "22", intendedDomain: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { server } = await createServer({
        name: form.name.trim(),
        host: form.host.trim(),
        sshUser: form.sshUser.trim(),
        sshPort: Number(form.sshPort) || 22,
      });
      const { runId } = await planRun("cluster-adopt", {
        serverId: server.id,
        ...(form.intendedDomain.trim() ? { intendedDomain: form.intendedDomain.trim() } : {}),
      });
      nav(`/runs/${runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <span className="page__eyebrow">Adopt · step 1 of 2</span>
          <h2 className="page__title">Adopt a server</h2>
        </div>
      </header>

      <p className="callout">
        Where is the machine? We connect once with a one-time password to install a dedicated SSH key — the password is
        never stored.
      </p>

      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}

      <form className="card wizard-card" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Name</span>
            <input value={form.name} onChange={set("name")} placeholder="s1" pattern="[a-z0-9][a-z0-9-]*" required />
            <span className="field__hint">Lowercase letters, digits and dashes.</span>
          </label>
          <label className="field">
            <span className="field__label">Host</span>
            <input value={form.host} onChange={set("host")} placeholder="203.0.113.7" required />
          </label>
          <label className="field">
            <span className="field__label">SSH user</span>
            <input value={form.sshUser} onChange={set("sshUser")} placeholder="hostyour1 (non-root, sudo)" required />
            <span className="field__hint">A non-root sudo user — hardened boxes disable root SSH login.</span>
          </label>
          <label className="field">
            <span className="field__label">SSH port</span>
            <input value={form.sshPort} onChange={set("sshPort")} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field__label">
              Intended domain <em className="field__opt">optional</em>
            </span>
            <input value={form.intendedDomain} onChange={set("intendedDomain")} placeholder="s1.example.com" />
          </label>
        </div>
        <div className="form-foot">
          <button type="submit" className="btn btn--primary" disabled={busy || !form.name || !form.host}>
            {busy ? "Preparing…" : "Continue to plan"}
          </button>
        </div>
      </form>
    </section>
  );
}
