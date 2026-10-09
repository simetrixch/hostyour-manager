import { useState } from "react";
import { Link } from "react-router";
import type { TenantAppCatalogView, TenantWebsiteView } from "../../../shared/apps-manifest.ts";
import type { TenantStatus } from "../../../shared/enums.ts";
import { newWebsiteName, typedAliases, unknownDomainText, websiteDomainConfirm, websiteFolder, websiteSiteDialogConfirm } from "../tenantAppRows.ts";
import { appPurgeable } from "../tenantRows.ts";
import { setTenantWebsiteMain, setTenantWebsiteDomain, setTenantWebsiteSite } from "../api-tenant-websites.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { OwnerCredentialStep } from "./OwnerCredentialStep.tsx";
import { TenantDeployWebsiteDialog } from "./TenantDeployWebsiteDialog.tsx";

/** The Websites section of the tenant page: every website of the tenant with its address and
 *  its site, a row with Deploy for every site of the tenant's bundle that is not deployed, the dialog
 *  that moves one to another domain or gives it alias domains, and the dialog that moves one to
 *  another site of the tenant's bundle, or marks it as the tenant's main website ("Hauptseite unter /":
 *  at most one website holds it, and marking one clears it on the other). A website is typed without `www.`: it is served at `<domain>`,
 *  and `www.<domain>` and each alias with its `www.` redirect there. It is named after its site when it
 *  is deployed. Deploy waits while the owner's packages reader is not recorded, and the step that
 *  records it stands below the list. A website the tenant removed keeps its row here, with the purge of
 *  its leftovers (`onPurge`) while it stands offboarded. Every action only PLANS its run and hands off to the Run screen. */
export function TenantWebsites(props: {
  tenantId: string;
  catalog: TenantAppCatalogView | null;
  /** The live websites (listedWebsites): a domain is null where only the inventory could name the website. */
  websites: readonly { name: string; site: string; domain: string | null; aliases: readonly string[]; main: boolean }[];
  /** The websites the tenant removed: name, site, status (offboarded until purged) and the run that removed each. */
  removed: readonly { name: string; site: string; status: TenantStatus; lastRunId: string | null }[];
  busy: boolean;
  act: (fn: () => Promise<{ runId: string }>) => Promise<void>;
  onRemove: (app: string) => void;
  onPurge: (app: string) => void;
  onRecordPackagesReader: (owner: string, token: string) => Promise<void>;
}) {
  const { tenantId, catalog, busy, act } = props;
  const folder = catalog ? websiteFolder(catalog.apps, catalog.websites) : null;
  const websites = props.websites;
  const unknownDomain = unknownDomainText(catalog);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [moving, setMoving] = useState<TenantWebsiteView | null>(null);
  const [next, setNext] = useState("");
  const [aliasText, setAliasText] = useState("");
  const aliases = typedAliases(aliasText);
  const [resiting, setResiting] = useState<{ name: string; site: string; main: boolean } | null>(null);
  const [markMain, setMarkMain] = useState(false);
  const [nextSite, setNextSite] = useState("");
  const [bundleTag, setBundleTag] = useState("");
  const siteTyped = nextSite.trim().toLowerCase();
  const tagTyped = bundleTag.trim().toLowerCase();
  const nextTyped = next.trim().toLowerCase();
  const siteConfirm = resiting ? websiteSiteDialogConfirm(resiting, siteTyped, tagTyped, markMain) : null;
  // The bundle installs private packages with the owner's reader, asked where none is recorded yet.
  const reader = catalog?.packagesReader;
  const readerMissing = reader !== undefined && reader.recorded === null;
  if (!folder && websites.length === 0 && props.removed.length === 0) return null;
  return (
    <>
      <h3 className="steps-panel__title">Websites</h3>
      <ul className="rows">
        {websites.map((w) => (
          <li key={w.name}>
            <div className="row">
              {w.main && <span className="chip">main</span>}
              <span className="row__title">{w.name}</span>
              <span className="row__meta">
                {w.domain !== null ? <a href={`https://${w.domain}/`} target="_blank" rel="noreferrer">{w.domain}</a> : unknownDomain} · site {w.site}
                {w.aliases.length > 0 && ` · aliases ${w.aliases.join(", ")}`}
              </span>
              <span className="row__end">
                {w.domain !== null && (
                  <button type="button" className="btn" disabled={busy} onClick={() => { const domain = w.domain!; setNext(domain); setAliasText(w.aliases.join(", ")); setMoving({ name: w.name, site: w.site, domain, aliases: [...w.aliases] }); }}>
                    Domain and aliases…
                  </button>
                )}
                <button type="button" className="btn" disabled={busy} onClick={() => { setNextSite(""); setBundleTag(""); setMarkMain(false); setResiting({ name: w.name, site: w.site, main: w.main }); }}>
                  Site…
                </button>
                <button type="button" className="btn btn--danger" disabled={busy} onClick={() => props.onRemove(w.name)}>
                  Remove
                </button>
              </span>
            </div>
          </li>
        ))}
        {props.removed.map((w) => (
          <li key={w.name}>
            <div className="row">
              <span className="chip">removed</span>
              <span className="row__title">{w.name}</span>
              <span className="row__meta">site {w.site}</span>
              <span className="row__end">
                {w.lastRunId && (
                  <Link className="btn" to={`/runs/${w.lastRunId}`}>
                    Last run →
                  </Link>
                )}
                {appPurgeable(w.status) && (
                  <button type="button" className="btn btn--danger" disabled={busy} onClick={() => props.onPurge(w.name)}>
                    Purge
                  </button>
                )}
              </span>
            </div>
          </li>
        ))}
        {folder?.sites?.map((s) => (
          <li key={`bundle-${s}`}>
            <div className="row">
              <span className="chip">in the bundle</span>
              <span className="row__title">{s}</span>
              <span className="row__meta">not deployed</span>
              <span className="row__end">
                <button type="button" className="btn btn--primary" disabled={busy || readerMissing} onClick={() => setDeploying(s)}>
                  Deploy
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {folder && readerMissing && <OwnerCredentialStep owner={reader.owner} need={{ kind: "packages-reader", scopes: reader.scopes }} onRecord={props.onRecordPackagesReader} subject="The bundle" />}
      {catalog && folder && deploying && (
        <TenantDeployWebsiteDialog tenantId={tenantId} folder={folder.name} site={deploying} name={newWebsiteName(catalog, deploying)} firstWebsite={websites.length === 0} mainWebsite={websites.find((w) => w.main)?.name ?? null} act={act} onClose={() => setDeploying(null)} />
      )}
      {moving && (
        <ConfirmDialog
          title={`Domain and aliases of website ${moving.name}`}
          confirmLabel={websiteDomainConfirm({ domain: moving.domain, aliases: moving.aliases ?? [] }, nextTyped, aliases) ?? "Set the aliases"}
          confirmDisabled={websiteDomainConfirm({ domain: moving.domain, aliases: moving.aliases ?? [] }, nextTyped, aliases) === null}
          onCancel={() => setMoving(null)}
          onConfirm={() => { const w = moving; setMoving(null); void act(() => setTenantWebsiteDomain(tenantId, w.name, nextTyped, aliases)); }}
        >
          <label className="field">
            <span className="field__label">Domain, without www</span>
            <input className="input" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Alias domains without www, separated by commas</span>
            <input className="input" value={aliasText} onChange={(e) => setAliasText(e.target.value)} placeholder="example.com, example.net" />
          </label>
          <p>
            The website keeps its name {moving.name}. Each alias and its www host redirect permanently to the domain.
            {nextTyped !== moving.domain
              ? ` From the moment the new domain is recorded, the site answers only there; ${moving.domain} stays as an alias. A domain that is an alias now cannot become the domain in the same run.`
              : " The records of an alias you drop go once the site answers at its hosts. With the domain and the aliases left as they stand, the run writes only the host records the website misses."}
          </p>
        </ConfirmDialog>
      )}
      {resiting && siteConfirm && (
        <ConfirmDialog
          title={`Site of website ${resiting.name}`}
          confirmLabel={siteConfirm.label ?? "Move to the site"}
          confirmDisabled={siteConfirm.label === null}
          onCancel={() => setResiting(null)}
          onConfirm={() => { const w = resiting; setResiting(null); void act(() => (markMain && !w.main ? setTenantWebsiteMain(tenantId, w.name) : setTenantWebsiteSite(tenantId, w.name, siteTyped, tagTyped))); }}
        >
          <label className="field">
            <span className="field__label">Site, as the bundle's apps.yaml lists it</span>
            <input className="input" value={nextSite} onChange={(e) => setNextSite(e.target.value)} placeholder={resiting.site} />
          </label>
          <label className="field">
            <span className="field__label">Bundle release that carries the site, as its image tag</span>
            <input className="input" value={bundleTag} onChange={(e) => setBundleTag(e.target.value)} placeholder="0.4.015-stable-20261005150000-abc1234" />
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={resiting.main || markMain} disabled={resiting.main} onChange={(e) => setMarkMain(e.target.checked)} />
            <span className="field__label">Hauptseite unter /</span>
          </label>
          <p>
            {resiting.main ? "This is the main website; mark another website to move it." : "With the mark and no site typed, the website becomes the tenant's main website, and the website that holds it now loses it."}
          </p>
          {siteConfirm.why !== null && <p>{siteConfirm.why}</p>}
          <p>
            The website keeps its name {resiting.name}, its domain and its data. The site and the bundle release are recorded in one commit, and every
            member of the tenant moves onto that release. The release's migration renames the website's records at its first boot, so no abort moves
            it back.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
