import { useState, type ReactNode } from "react";
import { websitePath } from "../../../shared/tenant.ts";
import { addTenantWebsite } from "../api-tenant-websites.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The confirm of a bundle site's Deploy: the website answers on the tenant's host, the main website at
 *  `/` and every other at `/web/<site>`. `name` is the website's app name (newWebsiteName) and `folder`
 *  the bundle's website folder that runs it. "Hauptseite unter /" makes it the tenant's main website, ticked
 *  where it is the tenant's first (`firstWebsite`); `mainWebsite` names the website that holds that
 *  place now, which loses it. Confirming only PLANS the run and `act` hands off to its Run screen. */
export function TenantDeployWebsiteDialog(props: {
  tenantId: string;
  folder: string;
  site: string;
  name: string;
  firstWebsite: boolean;
  mainWebsite: string | null;
  act: (fn: () => Promise<{ runId: string }>) => Promise<void>;
  onClose: () => void;
}): ReactNode {
  const { tenantId, folder, site, name, firstWebsite, mainWebsite, act, onClose } = props;
  const [main, setMain] = useState(firstWebsite);
  const deploy = () => {
    onClose();
    void act(() => addTenantWebsite(tenantId, { app: name, site, folder, main }));
  };
  return (
    <ConfirmDialog title={`Deploy website ${name}`} confirmLabel="Deploy" onCancel={onClose} onConfirm={deploy}>
      <label className="checkbox-field">
        <input type="checkbox" checked={main} onChange={(e) => setMain(e.target.checked)} />
        <span className="field__label">Hauptseite unter /</span>
      </label>
      <p>
        The site {site} is served at {websitePath({ site, main })} of the tenant's host. The website is named {name}.
        {main && ` With the mark, it becomes the tenant's main website.${mainWebsite !== null ? ` ${mainWebsite} is the main website now and loses it.` : ""}`}
      </p>
    </ConfirmDialog>
  );
}
