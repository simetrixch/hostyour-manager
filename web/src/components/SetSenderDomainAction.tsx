import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The action-bar button that sets, switches or clears the domain the tenant's mail is sent as. One
 *  field: a domain, no address; empty sends as the platform's own domain again. Confirming only PLANS
 *  the run: the plan asks the product's mail service whether mail from the domain is signed and
 *  refuses it where not; the run records the domain and waits until every member renders it. */
export function SetSenderDomainAction(props: { subdomain: string; senderDomain: string; busy: boolean; onSet: (domain: string) => void }) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState(props.senderDomain);
  const value = next.trim().toLowerCase();
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => { setNext(props.senderDomain); setOpen(true); }}>
        Sender domain…
      </button>
      {open && (
        <ConfirmDialog
          title={`Sender domain of tenant "${props.subdomain}"`}
          confirmLabel={value === "" ? "Send as the platform" : `Send as no-reply@${value}`}
          onCancel={() => setOpen(false)}
          onConfirm={() => { setOpen(false); props.onSet(value); }}
        >
          <p>
            <label>
              Domain (empty sends as the platform&apos;s own domain){" "}
              <input className="input" value={next} onChange={(e) => setNext(e.target.value)} placeholder="example.org" />
            </label>
          </p>
          <p>
            The tenant&apos;s mail, such as a password reset, is then sent as no-reply@ this domain. The plan first asks
            the product&apos;s mail service whether mail from the domain is signed, and refuses it where not. The domain&apos;s
            SPF record must allow the platform&apos;s mail server; that record is the domain owner&apos;s to set.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
