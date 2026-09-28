import { useState, type FormEvent } from "react";
import type { TenantAppCatalogView, TenantWebsiteView } from "../../../shared/apps-manifest.ts";
import { websiteAppName } from "../../../shared/tenant.ts";
import { websiteFolder } from "../tenantAppRows.ts";
import { addTenantWebsite, setTenantWebsiteDomain } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { OwnerCredentialStep } from "./OwnerCredentialStep.tsx";

/** The Websites section of the tenant page: every website of the tenant with its address and
 *  its site, the form that adds one, and the dialog that moves one to another domain. A website is
 *  typed without `www.`: it is served at `<domain>`, `www.<domain>` redirects there, and it is named
 *  by the domain it is added with. Every action only PLANS its run and hands off to the Run screen. */
export function TenantWebsites(props: {
  tenantId: string;
  catalog: TenantAppCatalogView | null;
  busy: boolean;
  act: (fn: () => Promise<{ runId: string }>) => Promise<void>;
  onRemove: (app: string) => void;
  onRecordPackagesReader: (owner: string, token: string) => Promise<void>;
}) {
  const { tenantId, catalog, busy, act } = props;
  const folder = catalog ? websiteFolder(catalog.apps) : null;
  const websites = catalog?.websites ?? [];
  const [domain, setDomain] = useState("");
  const [site, setSite] = useState("");
  const [moving, setMoving] = useState<TenantWebsiteView | null>(null);
  const [next, setNext] = useState("");
  const typed = domain.trim().toLowerCase();
  const nextTyped = next.trim().toLowerCase();
  const named = typed ? websiteAppName(typed) : "";
  // The bundle installs private packages with the owner's reader, asked where none is recorded yet.
  const reader = catalog?.packagesReader;
  const readerMissing = reader !== undefined && reader.recorded === null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (folder && typed && site) void act(() => addTenantWebsite(tenantId, { domain: typed, site, folder: folder.name }));
  };
  if (!folder && websites.length === 0) return null;
  return (
    <>
      <h3 className="steps-panel__title">Websites</h3>
      {websites.length === 0 ? (
        <div className="empty">
          <p>No website yet.</p>
        </div>
      ) : (
        <ul className="rows">
          {websites.map((w) => (
            <li key={w.name}>
              <div className="row">
                <span className="row__title">{w.name}</span>
                <span className="row__meta">
                  <a href={`https://${w.domain}/`} target="_blank" rel="noreferrer">{w.domain}</a> · site {w.site}
                </span>
                <span className="row__end">
                  <button type="button" className="btn" disabled={busy} onClick={() => { setNext(w.domain); setMoving(w); }}>
                    Change domain…
                  </button>
                  <button type="button" className="btn btn--danger" disabled={busy} onClick={() => props.onRemove(w.name)}>
                    Remove
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {folder && readerMissing && <OwnerCredentialStep owner={reader.owner} need={{ kind: "packages-reader", scopes: reader.scopes }} onRecord={props.onRecordPackagesReader} subject="The bundle" />}
      {folder && (
        <form className="field" onSubmit={submit}>
          <label className="field__label" htmlFor="tenant-add-website">
            Add website
          </label>
          <span className="field__hint">
            The domain without www: the site is served at {typed || "<domain>"}, and www.{typed || "<domain>"} redirects there.
            {named ? ` The website is named ${named}.` : ""}
          </span>
          <input id="tenant-add-website" className="input" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} disabled={busy} />
          <select className="input" value={site} onChange={(e) => setSite(e.target.value)} disabled={busy} aria-label="Site">
            <option value="" disabled>
              Choose its site
            </option>
            {(folder.sites ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <div className="actions">
            <button type="submit" className="btn btn--primary" disabled={busy || !typed || !site || readerMissing}>
              Add website
            </button>
          </div>
        </form>
      )}
      {moving && (
        <ConfirmDialog
          title={`Move website ${moving.name}`}
          confirmLabel={nextTyped ? `Serve at ${nextTyped}` : "Serve at the new domain"}
          confirmDisabled={!nextTyped || nextTyped === moving.domain}
          onCancel={() => setMoving(null)}
          onConfirm={() => { const w = moving; setMoving(null); void act(() => setTenantWebsiteDomain(tenantId, w.name, nextTyped)); }}
        >
          <label className="field">
            <span className="field__label">New domain, without www</span>
            <input className="input" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <p>
            The website keeps its name {moving.name}. From the moment the new domain is recorded, it answers only there; the records of {moving.domain} and www.{moving.domain} go once it answers at the new hosts.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
