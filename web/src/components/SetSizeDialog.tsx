import { useEffect, useState } from "react";
import { Link } from "react-router";
import { unitSizeOptions, type UnitSizeOptions } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** Pick a size for one unit — a consumer, or a tenant (whose members each get the chosen ceiling).
 *
 *  It SHOWS THE FIGURES, it does not just name the sizes. What `medium` means is a property of this
 *  installation's size table and the operator may have changed it minutes ago, so a picker offering
 *  three bare words would be asking someone to approve a number they cannot see.
 *
 *  And it shows THIS unit's figures, not the table's. A unit's ceiling is the base row plus what it
 *  brings — its own PostgreSQL, its own MongoDB times its member count — so the server composes the
 *  three sizes for the unit named in the path and hands back the parts beside each total. That is the
 *  same arithmetic the run will perform when it writes the registration.
 *
 *  Confirming only PLANS a run. The figures are read AGAIN when that run writes the registration, so
 *  what lands is the table as it stands at that moment — which is also why choosing the size a unit
 *  already has is a meaningful act rather than a no-op: it re-applies the current numbers. */
export function SetSizeDialog(props: {
  unit: string;
  /** Which family the unit belongs to, and its id — the two routes that compose the figures. The
   *  dialog asks the server rather than adding up rows itself. Two primitives and not an object,
   *  because a fresh object literal in JSX is a new value on every render and the fetch effect keys
   *  on these. */
  kind: "consumer" | "tenant";
  unitId: string;
  /** What the chosen figures bound, in words the operator reads inside the dialog: "its namespace"
   *  for a consumer, "EACH member namespace" for a tenant. A tenant reading a plain "3Gi" must not
   *  take it for the tenant's total. */
  scope: string;
  onCancel: () => void;
  onConfirm: (size: string) => void;
}) {
  const [options, setOptions] = useState<UnitSizeOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const { kind, unitId } = props;
  useEffect(() => {
    let alive = true;
    unitSizeOptions(kind, unitId)
      .then((r) => { if (alive) { setOptions(r); setChosen((c) => c ?? r.sizes[0]?.name ?? null); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [kind, unitId]);

  /** What the unit brings, in the words the manifest uses — the reason two units on `medium` can be
   *  quoted different figures. */
  const brings = options === null
    ? null
    : [
        options.brings.postgresql ? "its own PostgreSQL" : null,
        options.brings.mongodb === "shared" ? "the cluster's shared MongoDB" : `its own MongoDB (${options.brings.mongodb})`,
      ].filter((x) => x !== null).join(" and ");

  return (
    <ConfirmDialog
      title={`Set the size of "${props.unit}"?`}
      confirmLabel="Plan size change"
      onCancel={props.onCancel}
      onConfirm={() => { if (chosen) props.onConfirm(chosen); }}
    >
      <p>
        This <strong>plans</strong> a run and opens it — nothing changes on the cluster yet. What you approve is a
        ResourceQuota on <strong>{props.scope}</strong>.
      </p>
      {error && <p className="error">{error}</p>}
      {options === null && !error && <p className="muted">Loading the size table…</p>}
      {brings !== null && <p className="muted">These figures are composed for a unit that runs {brings}.</p>}
      {options?.composed === false && (
        <p className="muted">
          Consumer onboarding is not wired on this manager, so what this unit brings could not be read: the figures
          below are the base rows only.
        </p>
      )}
      {options?.sizes.map((s) => (
        <label className="field field--row" key={s.name}>
          <input type="radio" name="unit-size" value={s.name} checked={chosen === s.name} onChange={() => setChosen(s.name)} />
          <span>
            <strong>{s.name}</strong> — {s.quota.requestsCpu} CPU / {s.quota.requestsMemory} requested,{" "}
            {s.quota.limitsCpu} CPU / {s.quota.limitsMemory} at the limit, {s.quota.pods} pods,{" "}
            {s.quota.persistentVolumeClaims} PVCs
            {s.parts.length > 1 && (
              // The parts, so a total can be read back to where it came from: an operator who thinks
              // medium got expensive can see that three MongoDB members are in it.
              <span className="muted">
                {" "}({s.parts.map((p) => (p.members > 1 ? `${p.component} x${p.members}` : p.component)).join(" + ")})
              </span>
            )}
          </span>
        </label>
      ))}
      <p className="muted">
        The figures are read again when the run writes the registration, so choosing the size this unit already has
        re-applies whatever the table says now. Change what a size means on the <Link to="/sizes">Sizes</Link> screen.
      </p>
      <p className="muted">
        Nothing is rolled and nothing is evicted: Kubernetes applies the new ceiling to what is created from now on, so a
        namespace already above a lowered ceiling keeps its running pods and is refused the next one.
      </p>
    </ConfirmDialog>
  );
}
