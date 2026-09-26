import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The action-bar button that upgrades a tenant (hostyour-manager#296): every app of THIS tenant is
 *  moved onto the newest AVAILABLE version (what a release made available), and its member entries onto
 *  the product's manifest. No other tenant changes. A tenant already current runs green and changes
 *  nothing. Confirming only PLANS the run; the plan names every version it moves. */
export function RefreshMembersAction(props: { busy: boolean; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => setOpen(true)}>
        Upgrade
      </button>
      {open && (
        <ConfirmDialog
          title="Upgrade this tenant to the newest available versions"
          confirmLabel="Plan the upgrade"
          onCancel={() => setOpen(false)}
          onConfirm={() => { setOpen(false); props.onRefresh(); }}
        >
          <p>
            Every app of this tenant moves onto the newest version a release has made available, and its member
            entries onto the product&apos;s manifest. No other tenant changes. The plan lists every version that
            moves, and every missing image that is built first, before anything is written.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
