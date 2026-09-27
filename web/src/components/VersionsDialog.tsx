import { useEffect, useState, type ReactNode } from "react";
import type { VersionsView } from "../../../shared/api-types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** `0.1.16 · 27.09.2026 13:51 UTC` for a release or image tag `<x.y.z>-<channel>-<ts14>[-<sha7>]`, the
 *  channel said where it is not stable. */
function versionLabel(tag: string): string {
  const [version, channel, ts] = tag.split("-");
  const at = ts && ts.length === 14 ? `${ts.slice(6, 8)}.${ts.slice(4, 6)}.${ts.slice(0, 4)} ${ts.slice(8, 10)}:${ts.slice(10, 12)} UTC` : "";
  return [version, channel === "stable" ? "" : channel, at].filter(Boolean).join(" · ");
}

/** Choose the version each part runs. Per part, the versions that can be chosen, newest first; the one
 *  that runs is marked, and so is every older one, which makes choosing it a downgrade. A choice moves
 *  every build of its part. Confirming only PLANS the run, with the parts whose choice differs from what
 *  runs. */
export function VersionsDialog(props: {
  title: string;
  id: string;
  read: (id: string) => Promise<VersionsView>;
  onCancel: () => void;
  onConfirm: (versions: Record<string, string>) => void;
  /** Whether the run is worth planning with no version changed, because it does more than move versions. */
  plansUnchanged?: boolean;
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
  const selectedOf = (p: VersionsView["parts"][number]): string | undefined => chosen[p.name] ?? (p.running.length === 1 ? p.running[0] : undefined);
  const changes = Object.fromEntries(parts.flatMap((p) => {
    const tag = chosen[p.name];
    return tag !== undefined && !(p.running.length === 1 && p.running[0] === tag) ? [[p.name, tag]] : [];
  }));
  const downgrade = parts.some((p) => p.versions.some((v) => v.older && changes[p.name] === v.tag));
  const plannable = view !== null && (props.plansUnchanged === true || Object.keys(changes).length > 0);
  const newest = (): void => setChosen(Object.fromEntries(parts.flatMap((p) => (p.versions[0] ? [[p.name, p.versions[0].tag]] : []))));

  return (
    <ConfirmDialog
      title={props.title}
      confirmLabel={downgrade ? "Plan downgrade" : "Plan"}
      onCancel={props.onCancel}
      onConfirm={() => { if (plannable) props.onConfirm(changes); }}
    >
      {props.children}
      <p>
        A downgrade moves the images back only: a database the newer version migrated stays migrated, and the older
        version must run on it.
      </p>
      {error && <p className="error">{error}</p>}
      {view === null && !error && <p className="muted">Reading the versions…</p>}
      {view && parts.length === 0 && <p className="muted">Nothing here runs a version that can be chosen.</p>}
      {view && !plannable && parts.length > 0 && <p className="muted">Choose a version other than the one that runs to plan a change.</p>}
      {parts.length > 0 && (
        <p>
          <button type="button" className="btn" onClick={newest}>All to newest</button>
        </p>
      )}
      {parts.map((p) => (
        <div key={p.name}>
          <p>
            <strong>{p.name}</strong>
            {p.builds.length > 0 && <span className="muted"> — {p.builds.join(", ")}</span>}
          </p>
          {p.versions.length === 0 && <p className="muted">No version stands to choose from.</p>}
          {p.versions.map((v) => (
            <label className="field field--row" key={v.tag} title={v.tag}>
              <input type="radio" name={`version-${p.name}`} value={v.tag} checked={selectedOf(p) === v.tag} onChange={() => setChosen({ ...chosen, [p.name]: v.tag })} />
              <span>
                <strong>{versionLabel(v.tag)}</strong>
                {p.running.includes(v.tag) && <span className="muted"> — runs now</span>}
                {v.older && <span className="muted"> — older: a downgrade</span>}
              </span>
            </label>
          ))}
        </div>
      ))}
    </ConfirmDialog>
  );
}
