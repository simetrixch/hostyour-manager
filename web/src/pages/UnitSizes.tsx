import { useEffect, useState } from "react";
import { listUnitSizes, updateUnitSize, type UnitSizeView } from "../api.ts";

/** The size table: what `small`, `medium` and `large` MEAN on this installation.
 *
 *  A UNIT HAS ONE SIZE, AND THE TABLE HAS THREE ROWS PER SIZE. The one size the operator sells is
 *  `small`, `medium` or `large`; what it COSTS depends on what the unit brings with it. So the figures
 *  are kept per component — `base` is the application itself, `postgresql` is a PostgreSQL instance of
 *  its own, `mongodb` is ONE member of a MongoDB of its own — and a unit's ceiling is the base row plus
 *  the rows for what it brings, the MongoDB row times its member count (one for a standalone, three for
 *  a replica set). A consumer on the cluster's shared MongoDB adds nothing.
 *
 *  WHAT AN EDIT HERE REACHES, and what it does not. It changes the words, for every unit registered
 *  from that moment on. It reaches no running unit — a unit's registration carries the figures it was
 *  written with — so moving a deployed consumer or tenant onto the new numbers is a second, approved
 *  act: the "Set size" button on its own card, which re-reads this table and rewrites the
 *  registration. The screen says so rather than leaving the operator to discover it.
 *
 *  What is typed is checked on the SERVER (the quantity grammar in api-unit-sizes.ts), which is where
 *  a refusal can name the field that was wrong. */
/** The six figures as TEXT, which is what an input holds. `pods` and `persistentVolumeClaims` are
 *  numbers on the wire and strings here for one reason: a number input's spinner and locale handling
 *  get in the way of typing "500m" beside "10" in one row. */
interface SizeDraft {
  requestsCpu: string;
  requestsMemory: string;
  limitsCpu: string;
  limitsMemory: string;
  pods: string;
  persistentVolumeClaims: string;
}

/** What each component's rows are, in the operator's words — the figures alone do not say whether a
 *  number is a whole application's ceiling or one database member's share. */
const COMPONENT_LEDE: Record<UnitSizeView["component"], string> = {
  base: "The application itself — what every unit gets, whatever it brings. A unit that runs on the platform's shared databases is bounded by this row alone.",
  postgresql: "Added on top when the unit brings its OWN PostgreSQL (services: postgresql in its manifest). One instance, rendered at the unit's own size.",
  mongodb: "Added on top PER MEMBER when the unit brings its OWN MongoDB: once for a standalone, three times for a replica set. A unit on the cluster's shared replica set adds nothing.",
};

/** The row's key in the edit buffer — both halves of its primary key, since `medium` alone names
 *  three different rows. */
const rowKey = (s: UnitSizeView): string => `${s.component}/${s.name}`;

export function UnitSizes() {
  const [rows, setRows] = useState<UnitSizeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // The edit buffer: the six figures as typed, per row. Separate from `rows` so a half-typed value
  // never reads as the standing table. Typed as a complete SizeDraft rather than a loose string map,
  // so a field renamed here and not there is a build error instead of an empty box.
  const [draft, setDraft] = useState<Record<string, SizeDraft> | null>(null);

  function load(): void {
    listUnitSizes()
      .then((r) => {
        setRows(r.sizes);
        setDraft(Object.fromEntries(r.sizes.map((s) => [rowKey(s), {
          requestsCpu: s.requestsCpu, requestsMemory: s.requestsMemory,
          limitsCpu: s.limitsCpu, limitsMemory: s.limitsMemory,
          pods: String(s.pods), persistentVolumeClaims: String(s.persistentVolumeClaims),
        }])));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }
  useEffect(load, []);

  function save(s: UnitSizeView): void {
    const key = rowKey(s);
    const d = draft?.[key];
    if (!d) return;
    setSaving(key);
    setError(null);
    setSaved(null);
    updateUnitSize(s.component, s.name, {
      requestsCpu: d.requestsCpu, requestsMemory: d.requestsMemory,
      limitsCpu: d.limitsCpu, limitsMemory: d.limitsMemory,
      pods: Number(d.pods), persistentVolumeClaims: Number(d.persistentVolumeClaims),
    })
      .then(() => { setSaved(key); load(); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(null));
  }

  const FIELDS: Array<{ key: keyof SizeDraft; label: string }> = [
    { key: "requestsCpu", label: "requests.cpu" },
    { key: "requestsMemory", label: "requests.memory" },
    { key: "limitsCpu", label: "limits.cpu" },
    { key: "limitsMemory", label: "limits.memory" },
    { key: "pods", label: "pods" },
    { key: "persistentVolumeClaims", label: "PVCs" },
  ];

  // The components in the order they are summed, each with its own rows — the shape the ceiling is
  // built in, so an operator reading down the screen reads the sum.
  const components = rows === null ? [] : ([...new Set(rows.map((s) => s.component))]);

  return (
    <section className="section">
      <h1>Unit sizes</h1>
      <p className="section__lede">
        What each size means: the ceiling ONE namespace is bounded by. A consumer owns one namespace; a tenant owns one
        <strong> per member</strong>, so a tenant size applies to each of its members rather than to the tenant as a whole.
      </p>
      <p className="section__lede">
        A unit has <strong>one</strong> size. What that size costs depends on what the unit brings: its ceiling is the
        <strong> base</strong> row, plus <strong>postgresql</strong> when it runs its own, plus <strong>mongodb</strong>
        once per member when it runs its own. That is why each size is priced three times below.
      </p>
      <p className="section__lede">
        Changing a size here changes what is written into every registration <strong>from now on</strong>. It does not
        reach a unit that is already deployed — its registration carries the figures it was written with. Use
        <strong> Set size</strong> on that unit&apos;s own card to move it onto these numbers; that plans a run you approve.
      </p>

      {error && <p className="error">{error}</p>}
      {rows === null && !error && <p className="muted">Loading…</p>}

      {components.map((component) => (
        <div key={component}>
          <h2>{component}</h2>
          <p className="section__lede">{COMPONENT_LEDE[component]}</p>
          {rows?.filter((s) => s.component === component).map((s) => (
            <div className="card" key={rowKey(s)}>
              <h3>{s.name}</h3>
              <div className="grid">
                {FIELDS.map((f) => (
                  <label className="field" key={f.key}>
                    <span>{f.label}</span>
                    <input
                      className="input"
                      value={draft?.[rowKey(s)]?.[f.key] ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        setDraft((d) => {
                          const current = d?.[rowKey(s)];
                          // A row that is not in the buffer cannot be edited: the buffer is filled from
                          // the same fetch that produced the rows, so the two are never out of step.
                          return d && current ? { ...d, [rowKey(s)]: { ...current, [f.key]: value } } : d;
                        });
                      }}
                    />
                  </label>
                ))}
              </div>
              <div className="actions">
                <button type="button" className="btn btn--primary" disabled={saving === rowKey(s)} onClick={() => save(s)}>
                  {saving === rowKey(s) ? "Saving…" : "Save"}
                </button>
                {saved === rowKey(s) && <span className="muted">saved — units already deployed keep their figures until you set their size</span>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
