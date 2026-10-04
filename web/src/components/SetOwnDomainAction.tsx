import { useState } from "react";
import { ownDomainHosts } from "#unit/shared/unit-host.ts";
import { typedAliases } from "../tenantAppRows.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The action-bar button that sets, switches or clears the tenant's own domain, with its confirm. The
 *  operator types the domain without `www.`: the tenant is served at `<domain>` and `www.<domain>`
 *  redirects there, as each alias domain and its `www.` do, permanently. Confirming only PLANS the run: it points both hosts at the tenant's zone (or names
 *  the record to set where a host's zone is not managed here), records them, and waits until the
 *  identity provider answers at the domain and the www host redirects; the previous hosts' records
 *  are removed only then. */
export function SetOwnDomainAction(props: {
  subdomain: string;
  ownDomain: string;
  ownDomainAliases: readonly string[];
  busy: boolean;
  onSet: (domain: string, nestsUnder: string, aliases: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const standing = props.ownDomain.replace(/^www\./, "");
  const [next, setNext] = useState(standing);
  const [under, setUnder] = useState("");
  const [aliasText, setAliasText] = useState("");
  const aliases = typedAliases(aliasText);
  const value = next.trim().toLowerCase();
  const hosts = ownDomainHosts(value);
  const moving = standing !== "" && value !== "" && value !== standing;
  return (
    <>
      <button type="button" className="btn" disabled={props.busy} onClick={() => { setNext(standing); setUnder(""); setAliasText(props.ownDomainAliases.join(", ")); setOpen(true); }}>
        Own domain…
      </button>
      {open && (
        <ConfirmDialog
          title={`Own domain of tenant "${props.subdomain}"`}
          confirmLabel={value === "" ? "Return to the zone" : `Serve at ${hosts.ownDomain}`}
          onCancel={() => setOpen(false)}
          onConfirm={() => { setOpen(false); props.onSet(value, under.trim().toLowerCase(), value === "" ? [] : aliases); }}
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
          {value !== "" && (
            <p>
              <label>
                Alias domains without www, separated by commas{" "}
                <input className="input" value={aliasText} onChange={(e) => setAliasText(e.target.value)} placeholder="example.com, example.net" />
              </label>
              <span className="field__hint">
                Each alias and its www host redirect permanently to the own domain.
                {moving ? ` ${standing} stays as an alias after the move; a domain that is an alias now cannot become the own domain in the same run.` : ""}
              </span>
            </p>
          )}
          {value !== "" && (
            <p>
              <label>
                Lies under the domain of tenant (optional){" "}
                <input className="input" value={under} onChange={(e) => setUnder(e.target.value)} placeholder="subdomain of that tenant" />
              </label>
              <span className="field__hint">
                Only where this domain lies under another tenant&apos;s domain and both tenants are one owner&apos;s: a
                session cookie that tenant scopes to its domain then reaches this tenant too.
              </span>
            </p>
          )}
          <p>
            Every member is then served under a path of this host, which replaces the zone as the tenant&apos;s one
            host; the zone redirects to it too. The run points both hosts at the zone — or names the record to set
            where a host&apos;s DNS zone is not managed here — and waits until the identity provider answers at the
            domain and the www host redirects. Where a host&apos;s DNS zone is not managed here, set its record
            (a CNAME onto the tenant&apos;s zone) before you approve: from the moment the domain is recorded, the
            tenant answers only there.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
