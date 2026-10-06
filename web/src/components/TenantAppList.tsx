import { useState } from "react";
import { Link } from "react-router";
import type { TenantAppCatalogView } from "../../../shared/apps-manifest.ts";
import { planRun, type TenantDetailView } from "../api.ts";
import { tenantAppRows } from "../tenantAppRows.ts";
import { appRecordDeletable, tenantConfirmTitle, tenantRowOffer } from "../tenantRows.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { TenantStatusBadge } from "./TenantStatusBadge.tsx";

/** The Apps list of the tenant page: the bundle's apps lead, deployed or not, and an inventory row the
 *  bundle no longer names follows. While the catalog is unreadable the list is the inventory alone.
 *  A standing app row offers its removal (`onRemove`, whose confirm the page shares with its
 *  websites); an offboarded one offers the deletion of its record, which plans a run that first reads
 *  that nothing of the app remains. `editable` is false on a settled or unfinished tenant. */
export function TenantAppList(props: {
  tenant: TenantDetailView;
  catalog: TenantAppCatalogView | null;
  editable: boolean;
  busy: boolean;
  act: (fn: () => Promise<{ runId: string }>) => Promise<void>;
  onRemove: (app: string) => void;
}) {
  const { tenant: t, catalog, editable, busy, act, onRemove } = props;
  const [deleteRecord, setDeleteRecord] = useState<string | null>(null);
  const rows = tenantAppRows(catalog?.apps ?? [], t.apps, catalog?.websites);
  return (
    <>
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
                <span className="row__meta">{r.deployed ? `${t.guid}-${r.name}-${t.stage}` : "not deployed"}</span>
                <span className="row__end">
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
                  {r.row && editable && appRecordDeletable(r.row.status) && (
                    <button type="button" className="btn btn--danger" disabled={busy} onClick={() => setDeleteRecord(r.name)}>
                      Delete record
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {deleteRecord && (
        <ConfirmDialog
          title={tenantConfirmTitle.deleteAppRecord(t, deleteRecord)}
          confirmLabel="Delete record"
          destructive
          onCancel={() => setDeleteRecord(null)}
          onConfirm={() => {
            const app = deleteRecord;
            setDeleteRecord(null);
            void act(() => planRun("tenant-delete-app-record", { tenantId: t.id, app }));
          }}
        >
          <p>The plan first reads that nothing of the app remains: no namespace, no ArgoCD Application or AppProject, no admission policy, no Vault key. Then the app's row is deleted; the run stays in the audit trail.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
