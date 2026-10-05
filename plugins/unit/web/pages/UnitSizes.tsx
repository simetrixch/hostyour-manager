import { Fragment, useEffect, useState } from "react";
import { listUnitSizes, updateUnitSize, type UnitSizeView } from "#core/web/api.ts";
import { TENANT_SIZE, UNIT_SIZE, UNIT_SIZE_LETTER, type UnitSize } from "../../shared/unit-size.ts";

/** The size table: what each size (XS to XXL) MEANS on this installation.
 *
 *  THE TABLE HAS A ROW PER SIZE AND COMPONENT. A consumer is sold XS to XXL, each data part of its own
 *  at its own size, a tenant XS to L; what a size COSTS depends on what the unit brings with it. So the figures
 *  are kept per component — `base` is the application itself, `postgresql` is a PostgreSQL instance of
 *  its own, `mongodb` is ONE member of a MongoDB of its own, `redis` a Redis of its own — and a unit's ceiling is the base row plus
 *  the rows for what it brings, the MongoDB row times its member count (one for a standalone, three for
 *  a replica set). A consumer on the cluster's shared MongoDB adds nothing. A tenant member namespace
 *  is bounded by the `member` row alone. The page shows that as TWO tables, a tenant's rows and a
 *  consumer's with its four parts side by side, so each figure stands once (SizeTables).
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
export interface SizeDraft {
  requestsCpu: string;
  requestsMemory: string;
  limitsCpu: string;
  limitsMemory: string;
  pods: string;
  persistentVolumeClaims: string;
}

/** The consumer's components side by side, each in the operator's words: the figures alone do not say
 *  whether a number is a whole application's ceiling or one database member's share. */
const CONSUMER_PARTS: Array<{ component: Exclude<UnitSizeView["component"], "member">; title: string }> = [
  { component: "base", title: "Application" },
  { component: "postgresql", title: "+ own PostgreSQL" },
  { component: "mongodb", title: "+ own MongoDB, per member" },
  { component: "redis", title: "+ own Redis" },
];

const FIELDS: Array<{ key: keyof SizeDraft; label: string }> = [
  { key: "requestsCpu", label: "requests.cpu" },
  { key: "requestsMemory", label: "requests.memory" },
  { key: "limitsCpu", label: "limits.cpu" },
  { key: "limitsMemory", label: "limits.memory" },
  { key: "pods", label: "pods" },
  { key: "persistentVolumeClaims", label: "PVCs" },
];

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

  return (
    <section className="section">
      <h1>Unit sizes</h1>
      <p className="section__lede">
        What each size means: the ceiling ONE namespace is bounded by. A tenant has a namespace per app, so a tenant
        size applies to each of its apps; a consumer has one namespace, whose ceiling is its application plus what it
        brings of its own.
      </p>
      <p className="section__lede">
        Changing a size here changes what is written into every registration <strong>from now on</strong>. It does not
        reach a unit that is already deployed — its registration carries the figures it was written with. Use
        <strong> Set size</strong> on that unit&apos;s own card to move it onto these numbers; that plans a run you approve.
      </p>

      {error && <p className="error">{error}</p>}
      {rows === null && !error && <p className="muted">Loading…</p>}

      {rows !== null && draft !== null && (
        <SizeTables
          rows={rows} draft={draft} saving={saving} saved={saved} onSave={save}
          onEdit={(key, field, value) => setDraft((d) => {
            const current = d?.[key];
            // A row that is not in the buffer cannot be edited: the buffer is filled from the same
            // fetch that produced the rows, so the two are never out of step.
            return d && current ? { ...d, [key]: { ...current, [field]: value } } : d;
          })}
        />
      )}
    </section>
  );
}

/** One cell's input, labelled for a screen reader with its row, its part and its figure. */
function FigureInput(props: { label: string; value: string; onChange: (value: string) => void }) {
  return <input className="input" size={7} aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)} />;
}

/** The two tables: a tenant's per-app sizes, a row per size, and a consumer's, a row per size with its
 *  three parts side by side. Every figure appears once, and each row (and part) saves on its own. */
export function SizeTables(props: {
  rows: readonly UnitSizeView[];
  draft: Readonly<Record<string, SizeDraft>>;
  saving: string | null;
  saved: string | null;
  onEdit: (key: string, field: keyof SizeDraft, value: string) => void;
  onSave: (row: UnitSizeView) => void;
}) {
  const { rows, draft, saving, saved, onEdit, onSave } = props;
  const of = (component: UnitSizeView["component"]) => rows.filter((s) => s.component === component);
  const consumerSizes = [...new Set(CONSUMER_PARTS.flatMap((p) => of(p.component).map((s) => s.name)))].sort((a, b) => UNIT_SIZE.indexOf(a) - UNIT_SIZE.indexOf(b));
  const cells = (s: UnitSizeView, part: string) => (
    <>
      {FIELDS.map((f) => (
        <td key={f.key}>
          <FigureInput label={`${UNIT_SIZE_LETTER[s.name]} ${part} ${f.label}`} value={draft[rowKey(s)]?.[f.key] ?? ""} onChange={(v) => onEdit(rowKey(s), f.key, v)} />
        </td>
      ))}
      <td>
        <button type="button" className="btn btn--primary" disabled={saving === rowKey(s)} onClick={() => onSave(s)}>
          {saving === rowKey(s) ? "Saving…" : "Save"}
        </button>
        {saved === rowKey(s) && <span className="muted"> saved</span>}
      </td>
    </>
  );
  return (
    <>
      <h2>Tenant (per app)</h2>
      <p className="section__lede">Each app of a tenant runs in a namespace of its own, bounded by its row. XL and XXL are not offered until the apps run several replicas.</p>
      <div className="table__wrap">
        <table className="table">
          <thead>
            <tr><th>Size</th>{FIELDS.map((f) => <th key={f.key}>{f.label}</th>)}<th /></tr>
          </thead>
          <tbody>
            {of("member").map((s) => (
              <tr key={rowKey(s)}>
                <td>{UNIT_SIZE_LETTER[s.name]}{(TENANT_SIZE as readonly UnitSize[]).includes(s.name) ? "" : " (not offered)"}</td>
                {cells(s, "tenant app")}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Consumer</h2>
      <p className="section__lede">
        A consumer&apos;s ceiling is its application&apos;s row, plus its own PostgreSQL&apos;s when it runs one, plus its own
        MongoDB&apos;s once per member (one standalone, three for a replica set). On the shared databases it adds nothing.
      </p>
      <div className="table__wrap">
        <table className="table">
          <thead>
            <tr><th />{CONSUMER_PARTS.map((p) => <th key={p.component} colSpan={FIELDS.length + 1}>{p.title}</th>)}</tr>
            <tr><th>Size</th>{CONSUMER_PARTS.map((p) => [...FIELDS.map((f) => <th key={`${p.component}/${f.key}`}>{f.label}</th>), <th key={`${p.component}/save`} />])}</tr>
          </thead>
          <tbody>
            {consumerSizes.map((size) => (
              <tr key={size}>
                <td>{UNIT_SIZE_LETTER[size]}</td>
                {CONSUMER_PARTS.map((p) => {
                  const s = rows.find((r) => r.component === p.component && r.name === size);
                  return s ? <Fragment key={p.component}>{cells(s, p.title)}</Fragment> : <td key={p.component} colSpan={FIELDS.length + 1} className="muted">no row</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
