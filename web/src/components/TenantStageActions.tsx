import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { STAGE, type Stage } from "../../../shared/enums.ts";
import { addTenantStage, listTenants, listTenantTargets, type TenantView, type TenantTargetView } from "../api.ts";

export function TenantStageActions({ tenant }: { tenant: TenantView }) {
  const nav = useNavigate();
  const [siblings, setSiblings] = useState<TenantView[]>([]);
  const [targets, setTargets] = useState<TenantTargetView[]>([]);
  const [stage, setStage] = useState<Stage>("test");
  const [clusterId, setClusterId] = useState(tenant.clusterId);
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
      setStage(STAGE.find((s) => !stages.some((t) => t.stage === s)) ?? "test");
      setLoaded(true);
    }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [tenant.guid]);
  const missing = STAGE.filter((s) => !siblings.some((t) => t.stage === s));
  return <div className="card">
    <h3 className="steps-panel__title">Stages</h3>
    {siblings.map((sibling) => <p key={sibling.id}>
      <Link to={`/tenants/${sibling.id}`}>{sibling.stage}</Link> · {sibling.domain} · {sibling.status}
      {Object.entries(sibling.approvedTags).map(([member, builds]) => <span key={member} className="field__hint">{member}: {Object.entries(builds).map(([build, tag]) => `${build} ${tag}`).join(", ")}</span>)}
    </p>)}
    {error && <p className="alert alert--danger" role="alert">{error}</p>}
    {loaded && missing.length > 0 && <form onSubmit={(e) => {
      e.preventDefault(); setBusy(true); setError(null);
      addTenantStage(tenant.id, stage, clusterId).then(({ runId }) => nav(`/runs/${runId}`)).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false);
      });
    }}>
      <label className="field"><span className="field__label">Add stage</span><select value={stage} onChange={(e) => setStage(e.target.value as Stage)}>{missing.map((s) => <option key={s}>{s}</option>)}</select></label>
      <label className="field"><span className="field__label">Machine</span><select value={clusterId} required onChange={(e) => setClusterId(e.target.value)}>{targets.map((target) => <option key={target.id} value={target.id}>{target.domain}</option>)}</select></label>
      <p className="field__hint">Uses the same tenant identity and members, with fresh data, users, sessions and keys. Other stages stay as they are. Versions and follow releases are controlled separately on each stage page.</p>
      <button className="btn" disabled={busy || !clusterId}>Validate &amp; plan Add stage</button>
    </form>}
  </div>;
}
