import { useState } from "react";
import type { MemberRouting } from "../../../shared/enums.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The action-bar button that moves the members onto the OTHER routing, with its confirm.
 *  Confirming only PLANS the run: it provisions the new record, records the routing, waits until the
 *  identity provider answers at its new address, and removes the old record only then — which is why
 *  the product's charts must serve the new routing before the run can finish. */
export function SetRoutingAction(props: {
  subdomain: string;
  routing: MemberRouting;
  busy: boolean;
  onRoute: (next: MemberRouting) => void;
}) {
  const [open, setOpen] = useState(false);
  const next: MemberRouting = props.routing === "path" ? "host" : "path";
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => setOpen(true)}>
        Route by {next}…
      </button>
      {open && (
        <ConfirmDialog
          title={`Route tenant "${props.subdomain}" by ${next}?`}
          confirmLabel={`Route by ${next}`}
          onCancel={() => setOpen(false)}
          onConfirm={() => { setOpen(false); props.onRoute(next); }}
        >
          <p>
            {next === "path"
              ? "Every member moves under a path of the tenant's zone itself; the zone gets a DNS record of its own."
              : "Every member moves back onto a host of its own below the zone; the wildcard record returns."}{" "}
            The run provisions the new record, records the routing, and waits until the tenant&apos;s identity provider
            answers at its new address — the old record is removed only then. The product&apos;s charts must serve the
            new routing for that wait to end.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
