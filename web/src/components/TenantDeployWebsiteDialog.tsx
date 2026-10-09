import { useState, type ReactNode } from "react";
import { addTenantWebsite } from "../api-tenant-websites.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The confirm of a bundle site's Deploy: the domain the website is served at, which the run needs
 *  and the bundle cannot name. It is typed without `www.`: the site answers at `<domain>`, and
 *  `www.<domain>` redirects there. `name` is the website's app name (newWebsiteName) and `folder` the
 *  bundle's website folder that runs it. Confirming only PLANS the run and `act` hands off to its Run screen. */
export function TenantDeployWebsiteDialog(props: {
  tenantId: string;
  folder: string;
  site: string;
  name: string;
  act: (fn: () => Promise<{ runId: string }>) => Promise<void>;
  onClose: () => void;
}): ReactNode {
  const { tenantId, folder, site, name, act, onClose } = props;
  const [domain, setDomain] = useState("");
  const typed = domain.trim().toLowerCase();
  const deploy = () => {
    onClose();
    void act(() => addTenantWebsite(tenantId, { app: name, domain: typed, site, folder }));
  };
  return (
    <ConfirmDialog title={`Deploy website ${name}`} confirmLabel="Deploy" confirmDisabled={!typed} onCancel={onClose} onConfirm={deploy}>
      <label className="field">
        <span className="field__label">Domain, without www</span>
        <input className="input" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
      </label>
      <p>
        The site {site} is served at {typed || "<domain>"}, and www.{typed || "<domain>"} redirects there. The website is named {name}.
      </p>
    </ConfirmDialog>
  );
}
