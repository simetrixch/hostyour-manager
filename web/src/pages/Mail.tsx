import { useEffect, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router";
import { DMARC_POLICY, STAGE, type DmarcPolicy, type Stage } from "../../../shared/enums.ts";
import type { MailDnsDomainView, MailDnsRow, MailDnsView } from "../../../shared/mail.ts";
import { getMailDns, publishEnvelopeSpf, publishMailDns, publishPlatformDkim, unpublishMailDns } from "../api.ts";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The records, named as the records are named, in the order a receiver judges them. */
const RECORD_LABEL: Record<MailDnsRow["record"], string> = { spf: "SPF", "envelope-spf": "SPF (envelope)", a: "A", dkim: "DKIM", dmarc: "DMARC", ptr: "PTR" };

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

function DomainCard({ view, masterId, masterStage, onError }: { view: MailDnsDomainView; masterId: string; masterStage: Stage; onError: (m: string | null) => void }) {
  const nav = useNavigate();
  const [policy, setPolicy] = useState<DmarcPolicy>("none");
  const [dkimStage, setDkimStage] = useState<Stage>(masterStage);
  const [mailbox, setMailbox] = useState(() => reportMailboxOf(view.rows));
  const [busy, setBusy] = useState(false);
  const green = view.rows.filter((r) => r.ok).length;
  const envelope = view.rows.find((r) => r.record === "envelope-spf");

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

  /** The envelope sender's SPF, the one record of the platform under a domain whose other mail records
   *  are its own mail service's. A run like the publish, read on the Run screen before it is approved. */
  async function publishEnvelope(): Promise<void> {
    setBusy(true);
    onError(null);
    try {
      const { runId } = await publishEnvelopeSpf({ serverId: masterId });
      nav(`/runs/${runId}`);
    } catch (err) {
      onError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  /** The DKIM key a stage's mail sender signs the platform domain with, the one other record of the
   *  platform under a domain whose mail runs on its own mail service. The stage is the selector: the
   *  sender of another stage signs under its own. */
  async function publishDkim(): Promise<void> {
    setBusy(true);
    onError(null);
    try {
      const { runId } = await publishPlatformDkim({ serverId: masterId, stage: dkimStage });
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
      {envelope && (
        <div className="field">
          <span className="field__label">Envelope sender</span>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void publishEnvelope()}>
            {busy ? "Planning…" : `Publish the SPF of ${envelope.name}`}
          </button>
          <span className="field__hint">Writes the one v=spf1 record of {envelope.name}, the name the platform&apos;s mail transfer agent sends its envelope from, and nothing else.</span>
        </div>
      )}
      {view.publishRefusal !== null && (
        <div className="field">
          <span className="field__label">DKIM key of the stage&apos;s mail sender</span>
          <select value={dkimStage} onChange={(e: ChangeEvent<HTMLSelectElement>) => setDkimStage(e.target.value as Stage)}>
            {STAGE.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void publishDkim()}>
            {busy ? "Planning…" : `Publish the DKIM key under ${dkimStage}._domainkey.${view.domain}`}
          </button>
          <span className="field__hint">Writes the one DKIM record the mail sender of that stage signs {view.domain} with, and nothing of the domain&apos;s own mail service.</span>
        </div>
      )}
      {view.publishRefusal !== null ? (
        <p className="muted">{view.publishRefusal}.</p>
      ) : (
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
      )}
    </section>
  );
}

/** The installation's mail DNS as receivers see it, measured at public resolvers on every load, and
 *  the acts it offers through the master: publishing a sender domain's records, and the envelope
 *  sender's SPF under the platform domain, whose other records are its own mail service's. */
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
          {data.domains.map((d) => <DomainCard key={d.domain} view={d} masterId={data.master.serverId} masterStage={data.master.stage} onError={setError} />)}
        </>
      )}
    </section>
  );
}
