import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { DnsInventoryView, DnsRecordRow, DnsRecordType, DnsWritesView } from "../../../shared/dns.ts";
import { getDnsInventory, getDnsWrites, removeDnsRecords } from "../api.ts";
import { DnsWritesTable, recordKey, useRecordSelection, type DnsRemoveRecord } from "./DnsWrites.tsx";

// The DNS page in two tabs. FIRST the book: only the records a run of this Manager inserted or
// updated, with the run, the time and what stands there now — what an operator asks after a day's
// work. SECOND everything derived: every record this installation is responsible for at the DNS
// provider, standing or absent, which is what a tear-down needs. One act on both: the rows this
// Manager wrote can be ticked and taken back in ONE run, and a row it merely depends on is listed
// without a checkbox — the sender domain's address record is the installer's and the reverse DNS
// is set where the egress address is rented (shared/dns.ts states both).

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The three verdicts in the operator's words. `other` is the one that matters on a tear-down: a
 *  name of this installation answering with content nobody here would write is what an installation
 *  that is gone leaves behind. */
const VERDICT_LABEL: Record<DnsRecordRow["verdict"], string> = { standing: "standing", absent: "absent", other: "other content" };

function ownerCell(owner: DnsRecordRow["owner"]): string {
  return owner.stage === undefined ? `${owner.kind} ${owner.name}` : `${owner.kind} ${owner.name} (${owner.stage})`;
}

/** A row the run may take back: removable, and of a type the zone carries — never the PTR. */
type RemovableRow = DnsRecordRow & { type: DnsRecordType };
const isRemovable = (row: DnsRecordRow): row is RemovableRow => row.removable && row.type !== "PTR";

function RecordRow({ row, selected, onToggle }: { row: DnsRecordRow; selected: boolean; onToggle: () => void }) {
  return (
    <tr>
      <td>
        {isRemovable(row)
          ? <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${recordKey(row)}`} />
          : <span className="muted">read-only</span>}
      </td>
      <td>{ownerCell(row.owner)}</td>
      <td className="mono">{row.name}</td>
      <td>{row.type}</td>
      <td className="mono">{row.expected}</td>
      <td className="mono">{row.found ?? "none"}</td>
      <td><span className={row.verdict === "standing" ? "chip chip--ok" : "chip chip--warn"}>{VERDICT_LABEL[row.verdict]}</span></td>
    </tr>
  );
}

/** The derived tab's table. Mounted keyed on `data.readAt`, so a fresh reading starts with nothing ticked. */
function DnsInventoryTable({ data, busy, onRemove }: { data: DnsInventoryView; busy: boolean; onRemove: (records: DnsRemoveRecord[]) => void }) {
  const sel = useRecordSelection(data.rows.filter(isRemovable));
  return (
    <>
      {data.skipped.map((why) => <div key={why} className="alert alert--warn">{why}</div>)}
      <section className="card">
        <div className="card__head">
          <h3 className="page__title">
            {data.rows.length} record{data.rows.length === 1 ? "" : "s"}{" "}
            <span className="muted">· read {new Date(data.readAt).toLocaleTimeString()}</span>
          </h3>
          <button type="button" className="btn btn--danger" disabled={busy || sel.chosen.length === 0} onClick={() => onRemove(sel.chosen)}>
            Remove selected ({sel.chosen.length})
          </button>
        </div>
        <div className="table__wrap">
          <table className="table">
            <thead>
              <tr>
                <th><input type="checkbox" checked={sel.every} disabled={!data.rows.some(isRemovable)} onChange={sel.toggleAll} aria-label="Select every removable record" /></th>
                <th>Owner</th><th>Name</th><th>Type</th><th>Expected</th><th>Found</th><th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => <RecordRow key={recordKey(row)} row={row} selected={sel.isSelected(row)} onToggle={() => sel.toggle(row)} />)}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

type Tab = "written" | "derived";

/** Both readings are taken on load, and the removal either tab offers is the same RUN: this starts
 *  the plan over the ticked records and navigates to it, where the operator reads what stands at
 *  each and approves — a deletion at the provider is never one click here. The run resolves every
 *  name in the inventory, which is the permission, so a book row the inventory no longer carries
 *  refuses the whole run with a sentence naming it. */
export function Dns() {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("written");
  const [writes, setWrites] = useState<DnsWritesView | null>(null);
  const [data, setData] = useState<DnsInventoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getDnsWrites()
      .then((v) => setWrites(v))
      .catch((e: unknown) => setError(msg(e)));
    getDnsInventory()
      .then((v) => setData(v))
      .catch((e: unknown) => setError(msg(e)));
  }, []);

  async function remove(records: DnsRemoveRecord[]): Promise<void> {
    const count = records.length === 1 ? "this record" : `these ${records.length} records`;
    if (!window.confirm(`Remove ${count} at the DNS provider, in one run?\n\n${records.map(recordKey).join("\n")}`)) return;
    setBusy(true);
    setError(null);
    try {
      const { runId } = await removeDnsRecords({ records });
      nav(`/runs/${runId}`);
    } catch (e: unknown) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">DNS</h2>
        </div>
      </header>
      {error && <div className="alert alert--danger">{error}</div>}

      <div className="tabs" role="tablist" aria-label="DNS view">
        <button type="button" role="tab" id="tab-written" aria-selected={tab === "written"} aria-controls="panel-written" className={tab === "written" ? "tab tab--active" : "tab"} onClick={() => setTab("written")}>
          Written by this Manager
        </button>
        <button type="button" role="tab" id="tab-derived" aria-selected={tab === "derived"} aria-controls="panel-derived" className={tab === "derived" ? "tab tab--active" : "tab"} onClick={() => setTab("derived")}>
          Everything derived
        </button>
      </div>

      <div role="tabpanel" id="panel-written" aria-labelledby="tab-written" hidden={tab !== "written"}>
        {writes === null && !error && <p className="muted">Reading the book against the provider…</p>}
        {writes && <DnsWritesTable key={writes.readAt} data={writes} busy={busy} onRemove={(records) => void remove(records)} />}
      </div>

      <div role="tabpanel" id="panel-derived" aria-labelledby="tab-derived" hidden={tab !== "derived"}>
        {data === null && !error && <p className="muted">Reading the records at the provider…</p>}
        {data && <DnsInventoryTable key={data.readAt} data={data} busy={busy} onRemove={(records) => void remove(records)} />}
      </div>
    </section>
  );
}
