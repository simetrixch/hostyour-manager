import { useState, type ReactNode } from "react";
import type { TenantCatalogAppView } from "../../../shared/apps-manifest.ts";
import { appSelectionsToRequest } from "../../../shared/app-selections.ts";
import { addTenantApp } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The confirm of an app row's Deploy: the selections the app's apps.yaml entry declares, each box
 *  starting at the default the entry declares — the same offer the create-tenant wizard renders from
 *  the template's catalog, here from the tenant's own. No free text: what stands in the tenant's
 *  repository is what tenant-add-app accepts. Confirming only PLANS the run and `act` hands off to
 *  its Run screen. The dialog is mounted per open, so every open starts at the defaults. */
export function TenantDeployAppDialog(props: {
  tenantId: string;
  app: TenantCatalogAppView;
  act: (fn: () => Promise<{ runId: string }>) => Promise<void>;
  onClose: () => void;
}): ReactNode {
  const { tenantId, app, act, onClose } = props;
  const [chosen, setChosen] = useState<Record<string, boolean>>(Object.fromEntries(Object.entries(app.selections).map(([k, v]) => [k, v.default])));
  const deploy = () => {
    const { name, ...selections } = appSelectionsToRequest(app.name, chosen);
    onClose();
    void act(() => addTenantApp(tenantId, name, selections));
  };
  return (
    <ConfirmDialog title={`Deploy ${app.title} (${app.name})`} confirmLabel="Deploy" onCancel={onClose} onConfirm={deploy}>
      {app.description && <p>{app.description}</p>}
      <p>Plans the run that adds {app.title} to this tenant and opens it.</p>
      {Object.entries(app.selections).map(([selection, { title }]) => (
        <label key={selection} className="checkbox-field">
          <input type="checkbox" checked={chosen[selection] === true} onChange={(e) => setChosen((prev) => ({ ...prev, [selection]: e.target.checked }))} />
          <span className="field__label">{title}</span>
        </label>
      ))}
    </ConfirmDialog>
  );
}
