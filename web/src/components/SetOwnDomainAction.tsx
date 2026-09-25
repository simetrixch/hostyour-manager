import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The action-bar button that sets, switches or clears the tenant's own domain, with its confirm.
 *  Confirming only PLANS the run: it points the new domain at the tenant's zone (or names the record
 *  to set where the domain's zone is not managed here), records it, and waits until the identity
 *  provider answers at the new host; the previous domain's record is removed only then. */
export function SetOwnDomainAction(props: {
  subdomain: string;
  ownDomain: string;
  busy: boolean;
  onSet: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState(props.ownDomain);
  const value = next.trim().toLowerCase();
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => { setNext(props.ownDomain); setOpen(true); }}>
        Own domain…
      </button>
      {open && (
        <ConfirmDialog
          title={`Own domain of tenant "${props.subdomain}"`}
          confirmLabel={value === "" ? "Return to the zone" : `Serve at ${value}`}
          onCancel={() => setOpen(false)}
          onConfirm={() => { setOpen(false); props.onSet(value); }}
        >
          <p>
            <label>
              Domain (empty returns the tenant to its zone){" "}
              <input className="input" value={next} onChange={(e) => setNext(e.target.value)} placeholder="www.example.org" />
            </label>
          </p>
          <p>
            Every member is then served under a path of this domain, which replaces the zone as the tenant&apos;s one
            host; the zone keeps its record and redirects. The run points the domain at the zone — or names the record
            to set where its DNS zone is not managed here — and waits until the identity provider answers there. The
            product&apos;s charts must serve the domain, with its certificate, for that wait to end. Where the domain&apos;s
            DNS zone is not managed here, set its record (a CNAME onto the tenant&apos;s zone) before you approve: from the
            moment the domain is recorded, the tenant answers only there.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
