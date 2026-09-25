import { useEffect, useState, type FormEvent } from "react";
import type { OwnerCredentialView, OwnerIdentityView } from "#core/shared/api-types-owners.ts";
import { listOwners, recordOwnerCredential, forgetOwnerCredential } from "#core/web/api.ts";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Which = "packages-reader" | "repository-pat";

/**
 * THE INSTALLATION'S SETTINGS: what was answered once and is shown here, replaceable, never entered
 * ahead of time. Every tenant belongs to the one owner the platform's GitHub App is installed with;
 * a consumer is an owner of its own. Each owner's credentials were asked for in the onboarding that
 * needed them (the tenant's Add app form, the consumer wizard — #233, #237, #238) and stand here
 * afterwards: the PACKAGES READER (a token that reads the owner's private npm packages — GitHub
 * grants the App no access to a private package whatever its permissions say) and the REPOSITORY
 * PAT (the repository identity only where the App does not reach the owner's repositories). A
 * token is measured against GitHub before it is sealed, and only its fingerprint ever comes back.
 */
export function Settings() {
  const [owners, setOwners] = useState<OwnerIdentityView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh(): void {
    listOwners()
      .then((r) => setOwners(r.owners))
      .catch((e: unknown) => setError(msg(e)));
  }
  useEffect(refresh, []);

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">Settings</h2>
          <p className="page__desc">What this installation was answered once — shown here, replaced here, and asked for nowhere else than the onboarding that needs it.</p>
        </div>
      </header>

      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}

      {!owners ? (
        <div className="loading">
          <span className="spinner" aria-hidden="true" />
          Loading settings…
        </div>
      ) : (
        <ul className="cards">
          {owners.map((o) => (
            <OwnerCard key={o.org} entry={o} onChanged={refresh} onError={setError} />
          ))}
        </ul>
      )}
    </section>
  );
}

function OwnerCard(props: { entry: OwnerIdentityView; onChanged: () => void; onError: (m: string | null) => void }) {
  const { entry } = props;
  return (
    <li className="card">
      <div className="card__head">
        <strong className="servercard__name">{entry.org}</strong>
        <span className={entry.appInstalled ? "chip chip--ok" : "chip"}>
          {entry.appInstalled ? "GitHub App installed — the tenants' owner" : "a consumer's owner"}
        </span>
      </div>
      <CredentialRow
        org={entry.org}
        which="packages-reader"
        title="Packages reader"
        standing={entry.packagesReader}
        hint="The token the builds of this owner's units install private npm packages with (read:packages). Asked for once, where a repository routes a scope to GitHub Packages."
        absent="not recorded — asked for in the onboarding that needs it"
        onChanged={props.onChanged}
        onError={props.onError}
      />
      <CredentialRow
        org={entry.org}
        which="repository-pat"
        title="Repository PAT"
        standing={entry.repositoryPat}
        hint={entry.appInstalled
          ? "Not needed: the GitHub App is installed with this owner and is the identity of every repository of it."
          : "The repository identity of this owner's units (repo + workflow + admin:repo_hook). Asked for once, where the GitHub App does not reach a repository."}
        absent={entry.appInstalled ? "not needed" : "not recorded — asked for in the consumer wizard"}
        onChanged={props.onChanged}
        onError={props.onError}
      />
    </li>
  );
}

function CredentialRow(props: { org: string; which: Which; title: string; standing: OwnerCredentialView | null; hint: string; absent: string; onChanged: () => void; onError: (m: string | null) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [formKey, setFormKey] = useState(0);

  async function replace(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    props.onError(null);
    try {
      await recordOwnerCredential(props.org, props.which, token.trim());
      setToken("");
      setFormKey((k) => k + 1);
      props.onChanged();
    } catch (err) {
      props.onError(msg(err));
    }
    setBusy(false);
  }

  async function forget(): Promise<void> {
    setBusy(true);
    props.onError(null);
    try {
      await forgetOwnerCredential(props.org, props.which);
      props.onChanged();
    } catch (err) {
      props.onError(msg(err));
    }
    setBusy(false);
  }

  return (
    <form key={formKey} onSubmit={replace}>
      <div className="card__head">
        <strong>{props.title}</strong>
        {props.standing ? (
          <span className="chip chip--ok">recorded {new Date(props.standing.recordedAt).toLocaleDateString()} · {props.standing.fingerprint}</span>
        ) : (
          <span className="chip">{props.absent}</span>
        )}
      </div>
      <p className="servercard__reading">{props.hint}</p>
      {/* REPLACED HERE, NEVER ENTERED AHEAD OF TIME: the input stands only beside a recorded token. */}
      {props.standing && (
        <>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Replace with</span>
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_… or github_pat_…" autoComplete="off" />
            </label>
          </div>
          <div className="form-foot">
            <span className="field__hint">Measured against GitHub before it is sealed; only its fingerprint is kept in view.</span>
            <span className="page__actions">
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void forget()}>
                Forget
              </button>
              <button type="submit" className="btn btn--primary" disabled={busy || !token.trim()}>
                {busy ? "Measuring…" : "Replace"}
              </button>
            </span>
          </div>
        </>
      )}
    </form>
  );
}
