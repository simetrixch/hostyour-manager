import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The action-bar button that sets, switches or clears the tenant's own domain and the hosts that
 *  redirect to it, with its confirm. Confirming only PLANS the run: it points the new hosts at the
 *  tenant's zone (or names the record to set where a host's zone is not managed here), records them,
 *  and waits until the identity provider answers at the domain and every redirect host redirects; the
 *  previous hosts' records are removed only then. */
export function SetOwnDomainAction(props: {
  subdomain: string;
  ownDomain: string;
  ownDomainRedirects: string[];
  busy: boolean;
  onSet: (domain: string, redirects: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState(props.ownDomain);
  const [nextRedirects, setNextRedirects] = useState(props.ownDomainRedirects.join(" "));
  const value = next.trim().toLowerCase();
  const redirects = value === "" ? [] : nextRedirects.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={props.busy}
        onClick={() => { setNext(props.ownDomain); setNextRedirects(props.ownDomainRedirects.join(" ")); setOpen(true); }}
      >
        Own domain…
      </button>
      {open && (
        <ConfirmDialog
          title={`Own domain of tenant "${props.subdomain}"`}
          confirmLabel={value === "" ? "Return to the zone" : `Serve at ${value}`}
          onCancel={() => setOpen(false)}
          onConfirm={() => { setOpen(false); props.onSet(value, redirects); }}
        >
          <p>
            <label>
              Domain (empty returns the tenant to its zone){" "}
              <input className="input" value={next} onChange={(e) => setNext(e.target.value)} placeholder="www.example.org" />
            </label>
          </p>
          <p>
            <label>
              Redirect hosts (answer with a redirect to the domain; separated by spaces){" "}
              <input className="input" value={nextRedirects} disabled={value === ""} onChange={(e) => setNextRedirects(e.target.value)} placeholder="example.org" />
            </label>
          </p>
          <p>
            Every member is then served under a path of this domain, which replaces the zone as the tenant&apos;s one
            host; the zone and every redirect host redirect to it. The run points the domain and the redirect hosts at
            the zone — or names the record to set where a host&apos;s DNS zone is not managed here — and waits until the
            identity provider answers at the domain and every redirect host redirects. The product&apos;s charts must
            serve them, with their certificates, for that wait to end. Where a host&apos;s DNS zone is not managed here,
            set its record (a CNAME onto the tenant&apos;s zone) before you approve: from the moment the domain is
            recorded, the tenant answers only there.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
