import { useEffect, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router";
import { DMARC_POLICY, type DmarcPolicy } from "../../../shared/enums.ts";
import type { MailDnsDomainView, MailDnsRow, MailDnsView } from "../../../shared/mail.ts";
import { getMailDns, publishMailDns, unpublishMailDns } from "../api.ts";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The five records, named as the records are named, in the order a receiver judges them. */
const RECORD_LABEL: Record<MailDnsRow["record"], string> = { spf: "SPF", a: "A", dkim: "DKIM", dmarc: "DMARC", ptr: "PTR" };

/** The report mailbox a published DMARC record already names, so the form starts from what stands. */
function reportMailboxOf(rows: MailDnsRow[]): string {
  const found = rows.find((r) => r.record === "dmarc")?.found ?? "";
  const m = /rua=mailto:([^;,\s]+)/i.exec(found);
  return m?.[1] ?? "";
}

function RecordRow({ row }: { row: MailDnsRow }) {
  return (
    <tr>
      <td>{RECORD_LABEL[row.record]}</td>
      <td className="mono">{row.name}</td>
      <td><span className={row.ok ? "chip chip--ok" : "chip chip--warn"}>{row.ok ? "ok" : "missing"}</span></td>
      <td className="mono">{row.found ?? "none"}</td>
      <td className="mono">{row.expected}</td>
      <td>{row.ok ? "" : row.note}</td>
    </tr>
  );
}

function DomainCard({ view, masterId, onError }: { view: MailDnsDomainView; masterId: string; onError: (m: string | null) => void }) {
  const nav = useNavigate();
  const [policy, setPolicy] = useState<DmarcPolicy>("none");
  const [mailbox, setMailbox] = useState(() => reportMailboxOf(view.rows));
  const [busy, setBusy] = useState(false);
  const green = view.rows.filter((r) => r.ok).length;

  async function publish(): Promise<void> {
    setBusy(true);
    onError(null);
    try {
      const { runId } = await publishMailDns({ serverId: masterId, senderDomain: view.domain, dmarcPolicy: policy, dmarcMailbox: mailbox.trim() });
      nav(`/runs/${runId}`);
    } catch (err) {
      onError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  /** The inverse act, for a domain that stops sending: the SPF, the DKIM key and the DMARC policy
   *  go, the address record and the reverse DNS stay. It is a run like the publish, so what the
   *  three records stand at is read on the Run screen before anything is approved. */
  async function unpublish(): Promise<void> {
    if (!window.confirm(`Unpublish the mail DNS of ${view.domain}? Mail sent as this domain fails the checks receivers make the moment the SPF, DKIM and DMARC records are gone.`)) return;
    setBusy(true);
    onError(null);
    try {
      const { runId } = await unpublishMailDns(view.domain);
      nav(`/runs/${runId}`);
    } catch (err) {
      onError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3 className="page__title">
        {view.domain} <span className="muted">— {view.role}</span>{" "}
        <span className={green === view.rows.length ? "chip chip--ok" : "chip chip--warn"}>{green}/{view.rows.length} records</span>
      </h3>
      <div className="table__wrap">
        <table className="table">
          <thead>
            <tr><th>Record</th><th>Name</th><th>Verdict</th><th>Found</th><th>Expected</th><th>To do</th></tr>
          </thead>
          <tbody>
            {view.rows.map((row) => <RecordRow key={row.record} row={row} />)}
          </tbody>
        </table>
      </div>
      <div className="form-grid">
        <label className="field">
          <span className="field__label">DMARC policy</span>
          <select value={policy} onChange={(e: ChangeEvent<HTMLSelectElement>) => setPolicy(e.target.value as DmarcPolicy)}>
            {DMARC_POLICY.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <span className="field__hint">Start at none — reports without enforcement — and tighten once the reports show only this installation&apos;s mail.</span>
        </label>
        <label className="field">
          <span className="field__label">DMARC report mailbox</span>
          <input type="email" value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder="dmarc@example.com" required />
          <span className="field__hint">Where receivers send their aggregate reports — a mailbox somebody reads.</span>
        </label>
        <div className="field">
          <span className="field__label">Publish</span>
          <button type="button" className="btn btn--primary" disabled={busy || mailbox.trim() === ""} onClick={() => void publish()}>
            {busy ? "Planning…" : `Publish the mail DNS of ${view.domain}`}
          </button>
          <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void unpublish()}>
            {busy ? "Planning…" : `Unpublish ${view.domain}`}
          </button>
          <span className="field__hint">Unpublishing deletes this domain&apos;s SPF, DKIM and DMARC records at the DNS provider. Its address record stays and the reverse DNS is not in the zone.</span>
        </div>
      </div>
    </section>
  );
}

/** The installation's mail DNS as receivers see it, measured at public resolvers on every load, and
 *  the one act it offers: publishing a sender domain's records through the master. */
export function Mail() {
  const [data, setData] = useState<MailDnsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMailDns()
      .then((v) => setData(v))
      .catch((e: unknown) => setError(msg(e)));
  }, []);

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">Mail</h2>
        </div>
      </header>
      {error && <div className="alert alert--danger">{error}</div>}
      {data === null && !error && <p className="muted">Measuring…</p>}
      {data && (
        <>
          <section className="card">
            <h3 className="page__title">Where mail leaves</h3>
            <p>
              {data.sender
                ? <>Sender <span className="mono">{data.sender.unit}</span> on <span className="mono">{data.sender.cluster}</span> — the unit that declares the SMTP entry at {data.master.stage}; the relay on <span className="mono">{data.master.fqdn}</span> hands the alerts to it.</>
                : <>No unit declares an SMTP entry at {data.master.stage}; the relay on <span className="mono">{data.master.fqdn}</span> ({data.master.name}) delivers directly.</>}
            </p>
            <p>
              Mail leaves by <span className="mono">{data.egress.name}</span> at{" "}
              {data.egress.address ? <span className="mono">{data.egress.address}</span> : <span className="chip chip--warn">no address</span>}
              <span className="muted"> · measured {new Date(data.measuredAt).toLocaleTimeString()}</span>
            </p>
          </section>
          {data.domains.map((d) => <DomainCard key={d.domain} view={d} masterId={data.master.serverId} onError={setError} />)}
        </>
      )}
    </section>
  );
}
