import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { planRun, previewInstallationDomain } from "../api.ts";
import type { InstallationDomainSnapshot } from "../../../shared/installation-domain.ts";

export function InstallationDomain() {
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [sourceRun, setSourceRun] = useState("");
  const [dryRun, setDryRun] = useState(true), [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<InstallationDomainSnapshot | null>(null), [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  async function act(operation: "preview" | "move" | "rollback"): Promise<void> {
    setBusy(true); setError(null);
    try {
      if (operation === "preview") setPreview(await previewInstallationDomain(from, to));
      else {
        const result = await planRun(operation === "move" ? "installation-domain-move" : "installation-domain-rollback", operation === "move" ? { fromDomain: from, toDomain: to, dryRun } : { sourceRunId: sourceRun, dryRun });
        void navigate(`/runs/${result.runId}`);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent): void { event.preventDefault(); void act("preview"); }
  return <>
    <h1>Installation domain</h1>
    <p>Read the unit records, DNS book, registrations, issuer marks and cookie domains before the units move to the new domain. The new records point at the machines where they stand; old records stay, and each old unit host redirects to its new one. Everyone signs in once on the new hosts. Machines are renamed later, by their own runs.</p>
    {error && <p role="alert" className="alert alert--danger">{error}</p>}
    <form onSubmit={submit}>
      <div className="form-grid">
        <label className="field">Current domain<input required value={from} onChange={e => { setFrom(e.target.value); setPreview(null); }} autoComplete="off" /></label>
        <label className="field">New domain<input required value={to} onChange={e => { setTo(e.target.value); setPreview(null); }} autoComplete="off" /></label>
      </div>
      <div className="actions"><button className="btn btn--primary" disabled={busy}>Read preview</button></div>
    </form>
    {preview && <>
      <p>{preview.coverage.clusters} clusters, {preview.coverage.consumers} consumers and {preview.coverage.tenants} tenant stages read. Stages: {preview.coverage.stages.join(", ")}.</p>
      <p>{preview.coverage.persistedStores}. {preview.coverage.sessions}. {preview.coverage.cookieDomains}.</p>
      {preview.blockers.length > 0 && <div role="status" className="alert alert--danger"><strong>Cutover blocked</strong><ul>{preview.blockers.map(b => <li key={b}>{b}</li>)}</ul></div>}
      <h2>Records and book entries</h2>
      <div className="table-wrap"><table><thead><tr><th>Type</th><th>Current name/value</th><th>Proposed name/value</th><th>Book</th></tr></thead><tbody>{preview.records.map(r => <tr key={`${r.type} ${r.targetName}`}><td>{r.type}</td><td>{r.name}<br />{r.before}</td><td>{r.targetName}<br />{r.after}</td><td>{r.owner.kind} {r.owner.name} {r.owner.stage}; {r.targetBook ? "update target entry" : "add target entry"}; {r.targetName === r.name ? "same web record" : "old entry retained"}</td></tr>)}</tbody></table></div>
      <h2>Tenant identity providers and cookies</h2>
      <div className="table-wrap"><table><thead><tr><th>Tenant/stage</th><th>Derived issuer</th><th>Derived cookie domain / overrides</th></tr></thead><tbody>{preview.tenants.map(t => <tr key={`${t.guid}/${t.stage}`}><td>{t.guid}/{t.stage}</td><td>{t.issuerBefore}<br />→ {t.issuerAfter}</td><td>{t.cookieBefore || "host-only"}<br />→ {t.cookieAfter || "host-only"}{t.cookieOverrides.map(c => <div key={c.path.join(".")}>{c.path.join(".")}: {c.before || "host-only"} → {c.after || "host-only"}</div>)}</td></tr>)}</tbody></table></div>
      <details><summary>All recorded fields and unchanged book entries</summary><pre>{JSON.stringify(preview, null, 2)}</pre></details>
    </>}
    <h2>Record a run</h2>
    <label className="field"><span><input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} /> Dry run — read only</span></label>
    {!dryRun && <p role="alert">Apply belongs to the owner-led cutover. The run refuses unresolved machine or session blockers before writing.</p>}
    <div className="actions"><button className="btn" disabled={busy || !preview || (!dryRun && preview.blockers.length > 0)} onClick={() => void act("move")}>Plan move</button></div>
    <label className="field">Move run to roll back<input value={sourceRun} onChange={e => setSourceRun(e.target.value)} autoComplete="off" /></label>
    <div className="actions"><button className="btn" disabled={busy || !sourceRun} onClick={() => void act("rollback")}>Plan rollback</button></div>
  </>;
}
