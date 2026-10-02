import { useState } from "react";
import { getTenantVersions } from "../api.ts";
import { VersionsDialog } from "./VersionsDialog.tsx";
import { TenantLineMoveOffer } from "./TenantLineMoveOffer.tsx";

/** The action-bar button that opens a tenant's Versions dialog. Confirming only PLANS the run: the parts
 *  named move to the version chosen for each, and the member entries are resolved again off the
 *  product's manifest. Beside it, the switch that lets every release move the tenant by itself: the
 *  Manager then starts this same run when a release of a part the tenant renders succeeds at its
 *  stage (hostyour-manager#328). */
export function TenantVersionsAction(props: { tenantId: string; subdomain: string; busy: boolean; onSet: (versions: Record<string, string>) => void; onMoveLine: (line: string) => void; following: boolean; onFollow: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => setOpen(true)}>
        Versions…
      </button>
      <label className="checkbox-field" title="Every release of a part this tenant runs moves it by itself, through the Versions run">
        <input type="checkbox" checked={props.following} disabled={props.busy} onChange={(e) => props.onFollow(e.target.checked)} />
        <span className="field__label">Follow releases</span>
      </label>
      {open && (
        <VersionsDialog
          title={`Versions of tenant "${props.subdomain}"`}
          id={props.tenantId}
          read={getTenantVersions}
          onCancel={() => setOpen(false)}
          onConfirm={(versions) => { setOpen(false); props.onSet(versions); }}
        >
          <p>
            This <strong>plans</strong> a run and opens it. Every app of this tenant that uses a part moves with it, no other
            tenant changes, and the member entries are resolved again off the product&apos;s manifest.
          </p>
          <TenantLineMoveOffer tenantId={props.tenantId} busy={props.busy} onMove={(line) => { setOpen(false); props.onMoveLine(line); }} />
        </VersionsDialog>
      )}
    </>
  );
}
