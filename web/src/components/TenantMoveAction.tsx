import { useEffect, useState } from "react";
import { TENANT_SETTLED_STATUS } from "../../../shared/enums.ts";
import { tenantStagesNeedSeparateMachines } from "../../../shared/tenant-stage-placement.ts";
import { listTenants, listTenantTargets, type TenantView } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RelocationTargetDialog } from "./RelocationTargetDialog.tsx";

export function TenantMoveAction({ tenant, onCancel, onConfirm }: {
  tenant: Pick<TenantView, "guid" | "subdomain">;
  onCancel: () => void;
  onConfirm: (stage: TenantView, targetClusterId: string) => void;
}) {
  const [siblings, setSiblings] = useState<TenantView[] | null>(null);
  const [stageId, setStageId] = useState("");
  const [selected, setSelected] = useState<TenantView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    listTenants().then((all) => { if (active) setSiblings(all.filter((t) => t.guid === tenant.guid)); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [tenant.guid]);
  const stages = (siblings ?? []).filter((t) => t.status === "active" && !t.suspended);
  if (selected) return <RelocationTargetDialog
    title={`Move "${tenant.subdomain}" ${selected.stage} from ${selected.domain}?`}
    kind="move" confirmLabel="Plan stage move" currentClusterId={selected.clusterId}
    loadTargets={async () => (await listTenantTargets()).filter((target) => !(siblings ?? []).some((t) =>
      t.id !== selected.id && t.clusterId === target.id && tenantStagesNeedSeparateMachines(selected.stage, t.stage) && !TENANT_SETTLED_STATUS.some((status) => status === t.status)))}
    onCancel={onCancel} onConfirm={(target) => onConfirm(selected, target)}
  >
    <p>Only <strong>{selected.stage}</strong> moves, with every member, its data, registration and DNS record under the unchanged tenant identity. Other stages stay on their machines.</p>
    <p>This plans the existing sixteen-step Move. Access to this stage closes for backup and restore; the source is cleared last. You approve execution on the run page.</p>
  </RelocationTargetDialog>;
  return <ConfirmDialog title={`Move tenant "${tenant.subdomain}": choose its stage`}
    confirmLabel="Choose target machine" confirmDisabled={!stages.some((t) => t.id === stageId)}
    onCancel={onCancel} onConfirm={() => { const stage = stages.find((t) => t.id === stageId); if (stage) setSelected(stage); }}
  >
    {error && <p role="alert" className="alert alert--danger">{error}</p>}
    {siblings === null && !error && <p>Loading tenant stages…</p>}
    <label className="field"><span className="field__label">Stage</span>
      <select value={stageId} onChange={(e) => setStageId(e.target.value)}>
        <option value="">Choose a stage</option>
        {stages.map((t) => <option key={t.id} value={t.id}>{t.stage} · {t.domain}</option>)}
      </select>
    </label>
    {siblings !== null && stages.length === 0 && <p>No active, unsuspended stage is available to move.</p>}
    <p>Choose one stage first. The target machine is offered next; every other stage stays in place.</p>
  </ConfirmDialog>;
}
