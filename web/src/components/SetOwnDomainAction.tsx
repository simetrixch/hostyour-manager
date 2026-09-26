import { useState } from "react";
import { ownDomainHosts } from "#unit/shared/unit-host.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The action-bar button that sets, switches or clears the tenant's own domain, with its confirm. The
 *  operator types the domain without `www.`: the tenant is served at `www.<domain>` and `<domain>`
 *  redirects there. Confirming only PLANS the run: it points both hosts at the tenant's zone (or names
 *  the record to set where a host's zone is not managed here), records them, and waits until the
 *  identity provider answers at the www host and the bare domain redirects; the previous hosts'
 *  records are removed only then. */
export function SetOwnDomainAction(props: {
  subdomain: string;
  ownDomain: string;
  busy: boolean;
  onSet: (domain: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const standing = props.ownDomain.replace(/^www\./, "");
  const [next, setNext] = useState(standing);
  const value = next.trim().toLowerCase();
  const hosts = ownDomainHosts(value);
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => { setNext(standing); setOpen(true); }}>
        Own domain…
      </button>
      {open && (
        <ConfirmDialog
          title={`Own domain of tenant "${props.subdomain}"`}
          confirmLabel={value === "" ? "Return to the zone" : `Serve at ${hosts.ownDomain}`}
          onCancel={() => setOpen(false)}
          onConfirm={() => { setOpen(false); props.onSet(value); }}
        >
          <p>
            <label>
              Domain without www (empty returns the tenant to its zone){" "}
              <input className="input" value={next} onChange={(e) => setNext(e.target.value)} placeholder="example.org" />
            </label>
          </p>
          {value !== "" && (
            <p>
              The tenant is served at <strong>{hosts.ownDomain}</strong>, and <strong>{hosts.ownDomainRedirects.join(", ")}</strong> redirects there.
            </p>
          )}
          <p>
            Every member is then served under a path of this host, which replaces the zone as the tenant&apos;s one
            host; the zone redirects to it too. The run points both hosts at the zone — or names the record to set
            where a host&apos;s DNS zone is not managed here — and waits until the identity provider answers at the
            www host and the bare domain redirects. Where a host&apos;s DNS zone is not managed here, set its record
            (a CNAME onto the tenant&apos;s zone) before you approve: from the moment the domain is recorded, the
            tenant answers only there.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
