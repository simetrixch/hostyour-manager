import { useState } from "react";
import { Link } from "react-router";
import type { DnsRemoveInput, DnsVerdict, DnsWriteRow, DnsWritesView } from "#core/shared/dns.ts";

// The first tab of the DNS page: the book of what this Manager wrote. One row per record a run
// here inserted or updated, with the run that did it and what stands under the name now. The
// inventory (the second tab) lists everything the installation could own; this lists only what a run
// changed, which is what an operator checking a day's work wants first (hostyour-manager#171).
//
// Both tabs remove the same way: tick rows, one "Remove selected" starts ONE dns-remove run over the
// ticked records, and the run's plan names each before the approve. There is no per-row button,
// because a single record is the selection of one and a second way to start the same run would be
// a second thing to read (hostyour-manager#172). The selection hook lives here because this is the
// module the page already imports the table from.

/** The three verdicts in the operator's words, and the one for a row nobody could read. */
const VERDICT_LABEL: Record<DnsVerdict, string> = { standing: "standing", absent: "absent", other: "other content" };

export type DnsRemoveRecord = DnsRemoveInput["records"][number];

/** ONE record's key, the same string both tables and the run's step names are keyed by. Any row
 *  has one, a read-only row too, so a table asks it without first proving the row removable. */
export const recordKey = (r: { name: string; type: string }): string => `${r.type} ${r.name}`;

/** Which of the removable rows the operator ticked. `chosen` is what the run is sent, the name and
 *  the type of each and nothing else; `every` is the header checkbox's state, and `toggleAll` flips
 *  between all of them and none. */
export function useRecordSelection(removable: ReadonlyArray<DnsRemoveRecord>) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const every = removable.length > 0 && removable.every((r) => selected.has(recordKey(r)));
  return {
    isSelected: (r: { name: string; type: string }) => selected.has(recordKey(r)),
    chosen: removable.filter((r) => selected.has(recordKey(r))).map(({ name, type }): DnsRemoveRecord => ({ name, type })),
    every,
    toggle: (r: { name: string; type: string }) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(recordKey(r))) next.add(recordKey(r));
        return next;
      }),
    toggleAll: () => setSelected(every ? new Set() : new Set(removable.map(recordKey))),
  };
}

export function writeOwnerCell(owner: DnsWriteRow["owner"]): string {
  return owner.stage === undefined ? `${owner.kind} ${owner.name}` : `${owner.kind} ${owner.name} (${owner.stage})`;
}

function WriteRow({ row, selected, onToggle }: { row: DnsWriteRow; selected: boolean; onToggle: () => void }) {
  return (
    <tr>
      <td><input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${recordKey(row)}`} /></td>
      <td><span className={row.act === "inserted" ? "chip chip--ok" : "chip"}>{row.act}</span></td>
      <td>{writeOwnerCell(row.owner)}</td>
      <td className="mono">{row.name}</td>
      <td>{row.type}</td>
      <td className="mono">{row.content}</td>
      <td><Link className="mono" to={`/runs/${row.runId}`}>{row.runId}</Link></td>
      <td>{new Date(row.writtenAt).toLocaleString()}</td>
      <td>
        {row.verdict === null
          ? <span className="muted">not read</span>
          : <span className={row.verdict === "standing" ? "chip chip--ok" : "chip chip--warn"} title={row.found ?? "no record stands under the name"}>{VERDICT_LABEL[row.verdict]}</span>}
      </td>
    </tr>
  );
}

/** Mount it keyed on `data.readAt`: a fresh reading is a fresh table, and the selection starts empty. */
export function DnsWritesTable({ data, busy, onRemove }: { data: DnsWritesView; busy: boolean; onRemove: (records: DnsRemoveRecord[]) => void }) {
  const sel = useRecordSelection(data.rows);
  return (
    <>
      {data.skipped.map((why) => <div key={why} className="alert alert--warn">{why}</div>)}
      <section className="card">
        <div className="card__head">
          <h3 className="page__title">
            {data.rows.length} record{data.rows.length === 1 ? "" : "s"} written by this Manager{" "}
            <span className="muted">· read {new Date(data.readAt).toLocaleTimeString()}</span>
          </h3>
          <button type="button" className="btn btn--danger" disabled={busy || sel.chosen.length === 0} onClick={() => onRemove(sel.chosen)}>
            Remove selected ({sel.chosen.length})
          </button>
        </div>
        {data.rows.length === 0 && <p className="muted">No run of this Manager has inserted or updated a DNS record yet.</p>}
        {data.rows.length > 0 && (
          <div className="table__wrap">
            <table className="table">
              <thead>
                <tr>
                  <th><input type="checkbox" checked={sel.every} onChange={sel.toggleAll} aria-label="Select every record" /></th>
                  <th>Act</th><th>Owner</th><th>Name</th><th>Type</th><th>Content</th><th>Run</th><th>Written</th><th>Now</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => <WriteRow key={recordKey(row)} row={row} selected={sel.isSelected(row)} onToggle={() => sel.toggle(row)} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
