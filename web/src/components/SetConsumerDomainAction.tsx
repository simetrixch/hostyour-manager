import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The action-bar button that sets, switches or clears the domain a consumer answers at, at its
 *  stage, beside its platform host. Confirming only PLANS the run: it points the domain at the
 *  platform host (or names the record to set where the domain's zone is not managed here), records it
 *  on the stage registration, and waits until the consumer answers at it; the previous domain's record
 *  is removed only then. The plan names the domain the consumer has now. */
export function SetConsumerDomainAction(props: { name: string; stage: string; onSet: (fqdn: string) => void }) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState("");
  const value = next.trim().toLowerCase();
  return (
    <>
      <button type="button" className="btn" onClick={() => { setNext(""); setOpen(true); }}>
        Domain…
      </button>
      {open && (
        <ConfirmDialog
          title={`Domain of consumer "${props.name}" at ${props.stage}`}
          confirmLabel={value === "" ? "Clear the domain" : `Answer at ${value}`}
          onCancel={() => setOpen(false)}
          onConfirm={() => { setOpen(false); props.onSet(value); }}
        >
          <p>
            <label>
              Domain (empty clears it){" "}
              <input className="input" value={next} onChange={(e) => setNext(e.target.value)} placeholder="shop.example.org" />
            </label>
          </p>
          <p>
            The consumer then answers at this domain beside its platform host, which keeps answering. The run
            points the domain at the platform host — or names the record to set where its DNS zone is not
            managed here — and waits until the consumer answers there. Where the zone is not managed here, set
            that record (a CNAME onto the platform host) before you approve.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
