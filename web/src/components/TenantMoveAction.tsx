import { useState } from "react";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { tenantStagesNeedSeparateMachines } from "../../../shared/tenant-stage-placement.ts";
import { listTenants, listTenantTargets, type TenantView } from "../api.ts";
import { typedConfirmation } from "../tenantRows.ts";
import { RelocationTargetDialog } from "./RelocationTargetDialog.tsx";
import { TypeToConfirm } from "./TypeToConfirm.tsx";

/** Move the environment of the page it is opened on. Its siblings are read with the targets, to keep
 *  the stages that must stand apart off each other's machine. On PROD the operator first types the guid and the
 *  environment, as for an offboard or a purge. */
export function TenantMoveAction({ tenant, onCancel, onConfirm }: {
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
    loadTargets={async () => {
      const [all, targets] = await Promise.all([listTenants(), listTenantTargets()]);
      return targets.filter((target) => !all.some((t) => t.guid === tenant.guid && t.id !== tenant.id && t.clusterId === target.id && tenantStagesNeedSeparateMachines(tenant.stage, t.stage) && !TENANT_SETTLED_STATUS.some((status) => status === t.status)));
    }}
    onCancel={onCancel} onConfirm={(target) => onConfirm(tenant, target)}
  >
    {copy}
  </RelocationTargetDialog>;
}
