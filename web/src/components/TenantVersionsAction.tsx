import { useState } from "react";
import { getTenantVersions } from "../api.ts";
import { VersionsDialog } from "./VersionsDialog.tsx";

/** The action-bar button that opens a tenant's Versions dialog. Confirming only PLANS the run: the parts
 *  named move to the version chosen for each, and the member entries are resolved again off the
 *  product's manifest. */
export function TenantVersionsAction(props: { tenantId: string; subdomain: string; busy: boolean; onSet: (versions: Record<string, string>) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => setOpen(true)}>
        Versions…
      </button>
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
        </VersionsDialog>
      )}
    </>
  );
}
