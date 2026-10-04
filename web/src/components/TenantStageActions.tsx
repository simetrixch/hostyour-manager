import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { UNIT_SIZE, type UnitSize } from "#unit/shared/unit-size.ts";
import { addTenantStage, listTenants, listTenantTargets, type TenantView, type TenantTargetView } from "../api.ts";

export function TenantStageActions({ tenant }: { tenant: TenantView }) {
  const nav = useNavigate();
  // "+ add" on the environment bar opens this page with the environment it was pressed on.
  const [params] = useSearchParams();
  const asked = params.get("addStage");
  const [siblings, setSiblings] = useState<TenantView[]>([]);
  const [targets, setTargets] = useState<TenantTargetView[]>([]);
  const [stage, setStage] = useState<Stage>("test");
  // Neither the machine nor the size is proposed: a stage copied from another one is how TEST came to
  // stand on PROD's machine at the frugal default, so the operator chooses both.
  const [clusterId, setClusterId] = useState("");
  const [size, setSize] = useState<UnitSize | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([listTenants(), listTenantTargets()]).then(([all, machines]) => {
      if (!active) return;
      const stages = all.filter((t) => t.guid === tenant.guid);
      setSiblings(stages);
      setTargets(machines.filter((t) => t.status === "active"));
      const open = STAGE.filter((s) => !stages.some((t) => t.stage === s && t.status !== "purged"));
      setStage(open.find((s) => s === asked) ?? open[0] ?? "test");
      setLoaded(true);
    }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [tenant.guid, asked]);
  const missing = STAGE.filter((s) => !siblings.some((t) => t.stage === s && t.status !== "purged"));
  return <div className="card">
    <h3 className="steps-panel__title">Add stage</h3>
    {error && <p className="alert alert--danger" role="alert">{error}</p>}
    {loaded && missing.length > 0 && <form onSubmit={(e) => {
      e.preventDefault(); setBusy(true); setError(null);
      if (!size) return;
      addTenantStage(tenant.id, stage, clusterId, size).then(({ runId }) => nav(`/runs/${runId}`)).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false);
      });
    }}>
      <label className="field"><span className="field__label">Add stage</span><select value={stage} onChange={(e) => setStage(e.target.value as Stage)}>{missing.map((s) => <option key={s}>{s}</option>)}</select></label>
      <label className="field"><span className="field__label">Machine</span><select value={clusterId} required onChange={(e) => setClusterId(e.target.value)}><option value="" disabled>Choose a machine</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.domain}</option>)}</select></label>
      <label className="field"><span className="field__label">Size</span><select value={size} required onChange={(e) => setSize(e.target.value as UnitSize)}><option value="" disabled>Choose a size</option>{UNIT_SIZE.map((s) => <option key={s}>{s}</option>)}</select></label>
      <p className="field__hint">Uses the same tenant identity and members, with fresh data, users, sessions and keys, and the size chosen here for each of its member namespaces. Other stages stay as they are. Versions and follow releases are controlled separately on each stage page.</p>
      <button className="btn" disabled={busy || !clusterId || !size}>Validate &amp; plan Add stage</button>
    </form>}
  </div>;
}
