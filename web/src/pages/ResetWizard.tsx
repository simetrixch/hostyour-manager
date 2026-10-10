import { useEffect, useState, type FormEvent } from "react";
import type { BranchView, ResetResult } from "../../../shared/api-types.ts";
import { getBranches, resetManager } from "../api.ts";
import { ApiRequestError } from "../request.ts";
import { IconLock } from "../components/icons.tsx";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const KIND_ORDER: Record<BranchView["kind"], number> = { master: 0, manager: 1, slave: 2, other: 3 };

/** The full platform reset: strip the selected install branches' pointer files and delete those
 *  branches on GitHub. Safeguards, in order: master is LOCKED (never deletable, also refused
 *  server-side); the manager's own branch needs an explicit OFF-by-default opt-in; nothing fires
 *  until the operator types RESET. The VMs themselves are restored separately via Hyper-V — this
 *  wizard touches ONLY GitHub, and the Manager DB stays as it is. */
export function ResetWizard() {
  const [branches, setBranches] = useState<BranchView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [githubUnavailable, setGithubUnavailable] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [includeMaster, setIncludeMaster] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResetResult | null>(null);

  useEffect(() => {
    let alive = true;
    getBranches()
      .then((d) => {
        if (!alive) return;
        setBranches(d.branches);
        // Slaves are what a reset normally removes — pre-checked. master/manager/other never are.
        setSelected(new Set(d.branches.filter((b) => b.kind === "slave").map((b) => b.name)));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // GitHub not configured on this Manager: there is nothing to reset, which the form says.
        if (e instanceof ApiRequestError && e.code === "NOT_CONFIGURED") {
          setGithubUnavailable(true);
          setBranches([]);
        } else {
          setError(msg(e));
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const manager = branches?.find((b) => b.kind === "manager");
  const armed = confirm === "RESET" && selected.size > 0 && !busy;

  function toggle(name: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleIncludeMaster(): void {
    const next = !includeMaster;
    setIncludeMaster(next);
    // Withdrawing the opt-in also unselects the branch — a disabled-but-checked box would
    // silently keep it in the payload, and the UI must mirror the request 1:1.
    if (!next && manager && selected.has(manager.name)) toggle(manager.name);
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await resetManager({ confirm, deleteBranches: [...selected].sort(), includeMaster }));
    } catch (err) {
      setError(msg(err));
    }
    setBusy(false);
  }

  if (error !== null && branches === null)
    return (
      <p role="alert" className="alert alert--danger">
        Could not load the branches: {error}
      </p>
    );
  if (!branches)
    return (
      <div className="loading">
        <span className="spinner" aria-hidden="true" />
        Loading branches…
      </div>
    );

  // ---- Result view: exactly what happened, per item — replaces the form entirely. ----
  if (result) {
    return (
      <section className="page">
        <header className="page__head">
          <div>
            <span className="page__eyebrow">Danger zone</span>
            <h2 className="page__title">Reset — result</h2>
          </div>
        </header>

        {result.branches.length > 0 && (
          <ul className="rows">
            {result.branches.map((b) => (
              <li key={b.branch} className="resultrow">
                <span className={b.ok ? "resultrow__mark resultrow__mark--ok" : "resultrow__mark resultrow__mark--err"} aria-hidden="true">
                  {b.ok ? "✓" : "✕"}
                </span>
                <span className="resultrow__target">{b.branch}</span>
                <span className="resultrow__msg">
                  {b.ok
                    ? b.sha
                      ? <>deleted · <span className="mono">restore: git push origin {b.sha}:refs/heads/{b.branch}</span></>
                      : "deleted"
                    : b.error ?? "failed"}
                </span>
              </li>
            ))}
          </ul>
        )}

        <ul className="rows">
          <li className="resultrow">
            <span className="resultrow__mark resultrow__mark--ok" aria-hidden="true">✓</span>
            <span className="resultrow__target">pointer files</span>
            <span className="resultrow__msg">
              {result.pointers.removed.length === 0
                ? "none to remove"
                : <>removed {result.pointers.removed.length} on <span className="mono">{result.pointers.branch}</span>{result.pointers.commit ? <> · <span className="mono">{result.pointers.commit.slice(0, 8)}</span></> : null}</>}
            </span>
          </li>
        </ul>

        <p className="callout">
          The Manager database is unchanged: the servers and clusters of the deleted branches still stand in it, and a{" "}
          <span className="mono">cluster-remove-slave</span> run takes each one out. Rotate the GitHub tokens after any
          reset/restore — VM snapshots contain the old copies.
        </p>
        <div className="actions">
          <button type="button" className="btn" onClick={() => window.location.assign("/")}>
            Reload the Manager
          </button>
        </div>
      </section>
    );
  }

  const sorted = [...branches].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
  const chosen = [...selected].sort();

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <span className="page__eyebrow">Danger zone</span>
          <h2 className="page__title">Reset</h2>
          <p className="page__desc">Wind the platform back to zero: delete install branches on GitHub. The Manager&apos;s database stays.</p>
        </div>
      </header>

      <p role="alert" className="alert alert--danger">
        This is destructive and immediate. Run it while the Manager is still alive — GitHub cleanup must happen
        BEFORE any VM restore. It touches ONLY GitHub; the per-slave Vault mounts, ArgoCD
        instances and Headlamp contexts on the master disappear only when you restore the master VM — if you do NOT
        restore the master, run the <span className="mono">remove-slave</span> program on the master per slave afterwards.
      </p>

      {error !== null && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}

      <form className="card dangercard" onSubmit={(e) => void submit(e)}>
        <h3 className="dangercard__title">1 · Branches to delete</h3>
        {githubUnavailable ? (
          <p className="field__hint">
            GitHub is not configured on this Manager (GITHUB_REPO + GITHUB_WRITE_PAT), so a reset has nothing to do
            here.
          </p>
        ) : (
          <ul className="checkrows">
            {sorted.map((b) => {
              if (b.kind === "master")
                return (
                  <li key={b.name}>
                    <label className="checkrow checkrow--locked">
                      <input type="checkbox" checked={false} disabled readOnly />
                      <span className="checkrow__name">{b.name}</span>
                      <span className="checkrow__lock" aria-hidden="true">
                        <IconLock size={14} />
                      </span>
                      <span className="checkrow__meta">never deletable — the generic source</span>
                    </label>
                  </li>
                );
              const disabled = b.kind === "manager" && !includeMaster;
              return (
                <li key={b.name}>
                  <label className={disabled ? "checkrow checkrow--locked" : "checkrow"}>
                    <input type="checkbox" checked={selected.has(b.name)} disabled={disabled} onChange={() => toggle(b.name)} />
                    <span className="checkrow__name">{b.name}</span>
                    <span className="checkrow__meta">
                      {b.kind === "manager" ? "the manager's own branch · " : ""}
                      {b.compare ? `${b.compare.aheadBy} ahead · ${b.compare.changedFiles} ${b.compare.changedFiles === 1 ? "file" : "files"} changed` : "not compared"}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {manager && (
          <div className="optin">
            <label className="checkrow">
              <input type="checkbox" checked={includeMaster} onChange={toggleIncludeMaster} />
              <span>
                Also allow deleting <span className="mono">{manager.name}</span> — the manager&apos;s own install branch
              </span>
            </label>
            <p className="optin__warn">
              Keep this OFF to re-bootstrap by checking out the existing <span className="mono">{manager.name}</span>{" "}
              branch — your install overrides survive. Turn it ON only for a true from-zero re-bootstrap off master, and
              save this branch&apos;s diff from the Branches page first: it lists the overrides (manager deploy flag,
              sshUser, …) you must re-apply by hand.
            </p>
          </div>
        )}

        <h3 className="dangercard__title">2 · Confirm</h3>
        <p className="dangercard__summary">This will, in order:</p>
        <ul className="resetsummary">
          {chosen.length > 0 ? (
            <li>
              Remove their pointer files, then delete {chosen.length} {chosen.length === 1 ? "branch" : "branches"} from GitHub:{" "}
              <span className="mono">{chosen.join(", ")}</span>
            </li>
          ) : (
            <li>Delete no branches</li>
          )}
          <li>Keep the Manager database: its servers, clusters, runs and audit stay</li>
          <li>
            Never touch <span className="mono">master</span> — it stays, always
          </li>
        </ul>

        <label className="field">
          <span className="field__label">Type RESET to arm</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="RESET" autoComplete="off" spellCheck={false} />
          <span className="field__hint">The exact word, uppercase. The server refuses anything else too.</span>
        </label>

        <div className="form-foot">
          <span className="field__hint">Nothing happens until you click — and the server re-checks every rule above.</span>
          <button type="submit" className="btn btn--destructive" disabled={!armed}>
            {busy ? "Resetting…" : "Reset now"}
          </button>
        </div>
      </form>
    </section>
  );
}
