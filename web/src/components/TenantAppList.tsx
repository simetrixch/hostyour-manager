import { useState } from "react";
import { Link } from "react-router";
import type { TenantAppCatalogView, TenantCatalogAppView } from "../../../shared/apps-manifest.ts";
import type { TenantDetailView } from "../api.ts";
import { appPath } from "../../../shared/tenant.ts";
import { tenantAppRows, undeployedApps } from "../tenantAppRows.ts";
import { appPurgeable, tenantRowOffer } from "../tenantRows.ts";
import { OwnerCredentialStep } from "./OwnerCredentialStep.tsx";
import { TenantDeployAppDialog } from "./TenantDeployAppDialog.tsx";
import { TenantStatusBadge } from "./TenantStatusBadge.tsx";

/** The Apps list of the tenant page: the bundle's apps lead, deployed or not, and an inventory row the
 *  bundle no longer names follows. While the catalog is unreadable the list is the inventory alone, and
 *  its `error` or `reason` is shown as it is, so an empty list never reads as "nothing to deploy".
 *  A bundle app that is not deployed offers Deploy: a dialog with the selections its apps.yaml entry
 *  declares, which only PLANS the run and hands off through `act`. Deploy waits while the owner's
 *  packages reader is not recorded, and the step that records it stands below the list
 *  (`onRecordPackagesReader`). A standing app row offers its removal (`onRemove`) and an offboarded
 *  one its purge (`onPurge`); the page owns both confirms and shares them with its websites.
 *  `editable` is false on a settled or unfinished tenant. */
export function TenantAppList(props: {
  tenant: TenantDetailView;
  catalog: TenantAppCatalogView | null;
  editable: boolean;
  busy: boolean;
  act: (fn: () => Promise<{ runId: string }>) => Promise<void>;
  onRemove: (app: string) => void;
  onPurge: (app: string) => void;
  onRecordPackagesReader: (owner: string, token: string) => Promise<void>;
}) {
  const { tenant: t, catalog, editable, busy, act, onRemove, onPurge } = props;
  const [deploying, setDeploying] = useState<TenantCatalogAppView | null>(null);
  const rows = tenantAppRows(catalog?.apps ?? [], t.apps, catalog?.websites);
  const deployable = editable ? undeployedApps(catalog?.apps ?? [], catalog?.members) : [];
  // The first tenant onboarding asks for the packages reader, none after: the step stands only while
  // the template routes a scope to GitHub Packages and the owner records no reader.
  const reader = catalog?.packagesReader;
  const readerMissing = reader !== undefined && reader.recorded === null;
  return (
    <>
      {catalog === null && <span className="field__hint">Loading the tenant&apos;s catalog…</span>}
      {catalog?.error && (
        <p role="alert" className="alert alert--danger">
          The tenant&apos;s catalog could not be read: {catalog.error}
        </p>
      )}
      {catalog?.reason && (
        <span className="field__hint" role="note">
          {catalog.reason}
        </span>
      )}
      {rows.length === 0 ? (
        <div className="empty">
          <p>No apps yet — this tenant runs only its standing members.</p>
        </div>
      ) : (
        <ul className="rows">
          {rows.map((r) => (
            <li key={r.name}>
              <div className="row">
                {r.row ? <TenantStatusBadge status={r.row.status} /> : <span className="chip">{r.deployed ? "deployed" : "in the bundle"}</span>}
                <span className="row__title">{r.entry ? `${r.entry.title} (${r.name})` : r.name}</span>
                <span className="row__meta">{r.deployed ? `${t.guid}-${r.name}-${t.stage} · at ${appPath(r.name)}` : "not deployed"}</span>
                <span className="row__end">
                  {deployable.some((a) => a.name === r.name) && r.entry && (
                    <button type="button" className="btn btn--primary" disabled={busy || readerMissing} onClick={() => setDeploying(r.entry)}>
                      Deploy
                    </button>
                  )}
                  {r.row?.lastRunId && (
                    <Link className="btn" to={`/runs/${r.row.lastRunId}`}>
                      Last run →
                    </Link>
                  )}
                  {/* The per-app remove, gated by the SAME shared status rule as everything else on this
                      page: an app row that a remove-app or a tenant-wide removal already settled
                      ("offboarded" or "purged") has no Application left to prune. */}
                  {r.row && editable && !tenantRowOffer(r.row.status).settled && (
                    <button type="button" className="btn btn--danger" disabled={busy} onClick={() => onRemove(r.name)}>
                      Remove
                    </button>
                  )}
                  {r.row && editable && appPurgeable(r.row.status) && (
                    <button type="button" className="btn btn--danger" disabled={busy} onClick={() => onPurge(r.name)}>
                      Purge
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {deployable.length > 0 && readerMissing && <OwnerCredentialStep owner={reader.owner} need={{ kind: "packages-reader", scopes: reader.scopes }} onRecord={props.onRecordPackagesReader} subject="The bundle" />}
      {deploying && <TenantDeployAppDialog tenantId={t.id} app={deploying} act={act} onClose={() => setDeploying(null)} />}
    </>
  );
}
