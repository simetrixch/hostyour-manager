import { useState } from "react";
import { listTenantTargets, type TenantView } from "../api.ts";
import { machinesServing } from "../tenantPlacement.ts";
import { chosenForMove, movableEnvironments, typedConfirmation } from "../tenantRows.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RelocationTargetDialog } from "./RelocationTargetDialog.tsx";
import { TypeToConfirm } from "./TypeToConfirm.tsx";

/** Move one environment of a tenant. The dialog starts with WHICH: the tenant's running environments,
 *  each with its machine, the page's own preselected — the operator chooses the stage, the page only
 *  suggests it. Then the chosen environment is moved as TenantMoveConfirm says. */
export function TenantMoveAction({ tenant, environments, onCancel, onConfirm }: {
  tenant: TenantView;
  /** Every tenant row the page knows; the tenant's own running ones are offered. */
  environments: readonly TenantView[];
  onCancel: () => void;
  onConfirm: (stage: TenantView, targetClusterId: string) => void;
}) {
  const offered = movableEnvironments(tenant, environments);
  const [pick, setPick] = useState(tenant.id);
  const [chosen, setChosen] = useState<TenantView | null>(null);
  if (chosen) return <TenantMoveConfirm tenant={chosen} onCancel={onCancel} onConfirm={onConfirm} />;
  return (
    <ConfirmDialog title={`Move an environment of "${tenant.subdomain}"`} confirmLabel="Continue" onCancel={onCancel}
      onConfirm={() => setChosen(chosenForMove(offered, pick, tenant))}>
      <fieldset>
        <legend>Choose the environment to move</legend>
        {offered.map((r) => (
          <label key={r.id} className="field field--row">
            <input type="radio" name="move-stage" value={r.id} checked={r.id === pick} onChange={() => setPick(r.id)} />
            {" "}{r.stage.toUpperCase()} · {r.domain}
          </label>
        ))}
      </fieldset>
    </ConfirmDialog>
  );
}

/** Move the chosen environment onto a machine that serves its stage. On PROD the operator first types
 *  the guid and the environment, as for an offboard or a purge. */
export function TenantMoveConfirm({ tenant, onCancel, onConfirm }: {
  tenant: TenantView;
  onCancel: () => void;
  onConfirm: (stage: TenantView, targetClusterId: string) => void;
}) {
  const [typed, setTyped] = useState(tenant.stage !== "prod");
  const title = `Move "${tenant.subdomain}" ${tenant.stage} from ${tenant.domain}?`;
  const copy = <>
    <p>Only <strong>{tenant.stage}</strong> moves, with every member, its data, registration and DNS record under the unchanged tenant identity. Other stages stay on their machines.</p>
    <p>This plans the existing sixteen-step Move. Access to this stage closes for backup and restore; the source is cleared last. You approve execution on the run page.</p>
  </>;
  if (!typed) return <TypeToConfirm title={title} expected={typedConfirmation(tenant)} confirmLabel="Choose target machine" onCancel={onCancel} onConfirm={() => setTyped(true)}>{copy}</TypeToConfirm>;
  return <RelocationTargetDialog
    title={title} kind="move" confirmLabel="Plan stage move" currentClusterId={tenant.clusterId}
    loadTargets={async () => machinesServing(await listTenantTargets(), tenant.stage)}
    onCancel={onCancel} onConfirm={(target) => onConfirm(tenant, target)}
  >
    {copy}
  </RelocationTargetDialog>;
}
