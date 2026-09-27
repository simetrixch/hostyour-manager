import { useEffect, useState, type ReactNode } from "react";
import type { VersionsView } from "../../../shared/api-types.ts";
import { newestVersions, selectedVersion, versionChanges, versionLabel, versionOf } from "../versionChoice.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** Choose the version each part runs: one row per part with what it runs now, a list of the versions
 *  that can be chosen (newest first, the running one and every older one marked) and what a plan would
 *  change. A choice moves every build of its part. Confirming only PLANS the run, with the parts whose
 *  choice differs from what runs, and is possible only once something differs. */
export function VersionsDialog(props: {
  title: string;
  id: string;
  read: (id: string) => Promise<VersionsView>;
  onCancel: () => void;
  onConfirm: (versions: Record<string, string>) => void;
  children?: ReactNode;
}) {
  const [view, setView] = useState<VersionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});

  const { id, read } = props;
  useEffect(() => {
    let alive = true;
    read(id)
      .then((v) => { if (alive) setView(v); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [id, read]);

  const parts = view?.parts ?? [];
  const changes = versionChanges(parts, chosen);
  const isDowngrade = (p: VersionsView["parts"][number]): boolean => p.versions.some((v) => v.older && changes[p.name] === v.tag);
  const plannable = view !== null && Object.keys(changes).length > 0;

  return (
    <ConfirmDialog
      title={props.title}
      confirmLabel={parts.some(isDowngrade) ? "Plan downgrade" : "Plan"}
      confirmDisabled={!plannable}
      wide
      onCancel={props.onCancel}
      onConfirm={() => { if (plannable) props.onConfirm(changes); }}
    >
      {props.children}
      {error && <p role="alert" className="alert alert--danger">{error}</p>}
      {view === null && !error && <p className="field__hint">Reading the versions…</p>}
      {view && parts.length === 0 && <p className="field__hint">Nothing here runs a version that can be chosen.</p>}
      {parts.length > 0 && (
        <>
          <p>
            <button type="button" className="btn" onClick={() => setChosen(newestVersions(parts))}>All to newest</button>
          </p>
          <div className="table__wrap">
            <table className="table">
              <thead>
                <tr><th>Part</th><th>Runs now</th><th>Choose</th><th>Change</th></tr>
              </thead>
              <tbody>
                {parts.map((p) => {
                  const selected = selectedVersion(p, chosen);
                  const change = changes[p.name];
                  return (
                    <tr key={p.name}>
                      <td>
                        <strong>{p.name}</strong>
                        {p.builds.length > 0 && <div className="field__hint">{p.builds.join(", ")}</div>}
                      </td>
                      <td>{p.running.map(versionOf).join(" / ") || "–"}</td>
                      <td>
                        {p.versions.length === 0 ? <span className="field__hint">No version to choose</span> : (
                          <select className="input" aria-label={`Version of ${p.name}`} value={selected ?? ""} onChange={(e) => setChosen({ ...chosen, [p.name]: e.target.value })}>
                            {selected === undefined && <option value="" disabled>Choose…</option>}
                            {p.versions.map((v) => (
                              <option key={v.tag} value={v.tag} title={v.tag}>
                                {versionLabel(v.tag)}{p.running.includes(v.tag) ? " · runs now" : v.older ? " · downgrade" : ""}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        {change === undefined ? "–" : (
                          <>
                            {p.running.map(versionOf).join(" / ")} → {versionOf(change)}
                            {isDowngrade(p) && <> <span className="badge badge--degraded">downgrade</span></>}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="field__hint">
            A downgrade moves the images back only: a database the newer version migrated stays migrated, and the older
            version must run on it.
          </p>
        </>
      )}
    </ConfirmDialog>
  );
}
