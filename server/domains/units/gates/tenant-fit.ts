// T5 — the tenant's size fits its members' pods TWICE: each member namespace's ResourceQuota holds every
// pod its rendered workloads run, and a rolling update's surge on top, so a Versions or Set size run
// cannot leave a member whose next rollout the quota refuses. One cert-manager solver pod (CERT_SOLVER)
// is counted on top: it stands in the namespace while a certificate is issued or renewed.
//
// What a pod costs is what the quota admits it at: per resource, the larger of its main containers' sum
// and its largest init container (init containers run one at a time, before the main ones). A main
// container that does not declare its requests and limits fails the gate: the quota would admit it at
// the LimitRange default, which is no size anyone chose. An init container that does not is counted at
// that default and named, until the charts declare them too.
import type { GateResult } from "../../../../shared/gates.ts";
import { CERT_SOLVER, type UnitQuota } from "#unit/shared/unit-size.ts";
import { addCpu, addMemory, cpuMillis, memoryBytes } from "#unit/shared/quantity.ts";
import { capGateText } from "#unit/server/unit-host-gate.ts";
import type { MemberDocs } from "./tenant-gates.ts";

/** The member namespaces' LimitRange (hostyour-cloud apps/unit-quota): what a container that declares
 *  nothing is admitted at. */
export const LIMIT_RANGE_DEFAULT = { requestsCpu: "50m", requestsMemory: "64Mi", limitsCpu: "200m", limitsMemory: "128Mi" } as const;

type Figure = keyof typeof LIMIT_RANGE_DEFAULT;
const FIGURES: Figure[] = ["requestsCpu", "requestsMemory", "limitsCpu", "limitsMemory"];
const isCpu = (f: Figure): boolean => f === "requestsCpu" || f === "limitsCpu";
const amount = (f: Figure, v: string): number => (isCpu(f) ? cpuMillis(v) : memoryBytes(v));
type Cost = Record<Figure, number>;
const ZERO: Cost = { requestsCpu: 0, requestsMemory: 0, limitsCpu: 0, limitsMemory: 0 };

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

/** One container's four figures as written, or undefined where it writes none. */
function declared(c: Record<string, unknown>): Partial<Record<Figure, string>> {
  const res = rec(c.resources);
  const req = rec(res.requests);
  const lim = rec(res.limits);
  const s = (v: unknown): string | undefined => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
  const out: Partial<Record<Figure, string>> = {};
  const put = (f: Figure, v: string | undefined): void => { if (v !== undefined) out[f] = v; };
  put("requestsCpu", s(req.cpu)); put("requestsMemory", s(req.memory)); put("limitsCpu", s(lim.cpu)); put("limitsMemory", s(lim.memory));
  return out;
}

/** The pods one workload runs at its widest: a Deployment's replicas plus its rolling-update surge
 *  (maxSurge, 25% by default, rounded up; none for Recreate), a StatefulSet's replicas (it replaces
 *  one pod at a time and surges none). */
function widest(kind: string, spec: Record<string, unknown>): number {
  const replicas = typeof spec.replicas === "number" ? spec.replicas : 1;
  if (kind === "StatefulSet") return replicas;
  const strategy = rec(spec.strategy);
  if (strategy.type === "Recreate") return replicas;
  const surge = rec(strategy.rollingUpdate).maxSurge ?? "25%";
  if (typeof surge === "number") return replicas + surge;
  const pct = /^(\d+)%$/.exec(String(surge));
  return replicas + (pct ? Math.ceil((replicas * Number(pct[1])) / 100) : Number(surge) || 0);
}

interface MemberFit { member: string; pods: number; sum: Cost; problems: string[]; notes: string[] }

function fitOf(m: MemberDocs): MemberFit {
  const fit: MemberFit = { member: m.member, pods: 0, sum: { ...ZERO }, problems: [], notes: [] };
  const docs = m.docs.flatMap((d) => (d.kind === "List" ? list(rec(d.raw).items).map((raw) => ({ kind: String(raw.kind), name: String(rec(raw.metadata).name), raw })) : [d]));
  for (const d of docs) {
    if (d.kind !== "Deployment" && d.kind !== "StatefulSet") continue;
    const spec = rec(rec(d.raw).spec);
    const pod = rec(rec(spec.template).spec);
    const main = { ...ZERO };
    for (const c of list(pod.containers)) {
      const have = declared(c);
      const missing = FIGURES.filter((f) => have[f] === undefined);
      if (missing.length > 0) fit.problems.push(`${d.kind} ${d.name} container ${String(c.name)} declares no ${missing.join(", ")}`);
      for (const f of FIGURES) main[f] += have[f] === undefined ? 0 : amount(f, have[f]);
    }
    const init = { ...ZERO };
    for (const c of list(pod.initContainers)) {
      const have = declared(c);
      const missing = FIGURES.filter((f) => have[f] === undefined);
      if (missing.length > 0) fit.notes.push(`${d.kind} ${d.name} init container ${String(c.name)} counted at the LimitRange default for ${missing.join(", ")}`);
      for (const f of FIGURES) init[f] = Math.max(init[f], amount(f, have[f] ?? LIMIT_RANGE_DEFAULT[f]));
    }
    const pods = widest(d.kind, spec);
    fit.pods += pods;
    for (const f of FIGURES) fit.sum[f] += pods * Math.max(main[f], init[f]);
  }
  return fit;
}

const show = (f: Figure, n: number): string => (isCpu(f) ? addCpu(`${n}m`) : addMemory(String(n)));
const figures = (c: Cost, pods: number): string =>
  `requests ${show("requestsCpu", c.requestsCpu)}/${show("requestsMemory", c.requestsMemory)}, limits ${show("limitsCpu", c.limitsCpu)}/${show("limitsMemory", c.limitsMemory)}, ${pods} pod(s)`;

/** T5 over every rendered member against the ONE quota each member namespace gets. */
export function gateT5Fit(docsByMember: readonly MemberDocs[], quota: UnitQuota): GateResult {
  const ceiling: Cost = { requestsCpu: cpuMillis(quota.requestsCpu), requestsMemory: memoryBytes(quota.requestsMemory), limitsCpu: cpuMillis(quota.limitsCpu), limitsMemory: memoryBytes(quota.limitsMemory) };
  const quotaText = figures(ceiling, quota.pods);
  const expected =
    `every member namespace's pods fit its quota (${quotaText}) with a rolling update's surge on top: each Deployment at its replicas ` +
    `plus maxSurge, each StatefulSet at its replicas, each pod at the larger of its containers' sum and its largest init container, ` +
    `and one cert-manager solver pod; ` +
    `every main container declares its requests and limits`;
  const fits = docsByMember.map(fitOf);
  const solver = Object.fromEntries(FIGURES.map((f) => [f, amount(f, CERT_SOLVER[f])])) as Cost;
  const failures = fits.flatMap((f) => {
    const over = FIGURES.filter((g) => f.sum[g] + solver[g] > ceiling[g]).map((g) => g.replace(/([A-Z])/, " $1").toLowerCase());
    if (f.pods + CERT_SOLVER.pods > quota.pods) over.push("pods");
    return [
      ...f.problems.map((p) => `member "${f.member}": ${p}`),
      ...(over.length > 0 ? [`member "${f.member}" needs ${figures(f.sum, f.pods)} and one cert-manager solver pod (${figures(solver, CERT_SOLVER.pods)}), above the quota in ${over.join(", ")}`] : []),
    ];
  });
  const found = capGateText(fits.map((f) => `${f.member}: ${figures(f.sum, f.pods)}${f.notes.length > 0 ? ` (${f.notes.join("; ")})` : ""}`).join("; ") || "no member renders a workload");
  return failures.length === 0
    ? { id: "T5", title: "size fit", severity: "hard", status: "pass", expected, found, reason: null, detail: "every member fits its quota twice" }
    : {
      id: "T5", title: "size fit", severity: "hard", status: "fail", expected, found,
      reason: capGateText(`${failures.join("; ")} — the quota is ${quotaText} per member namespace; choose a larger size, or declare smaller shapes in the member's chart`),
      detail: "a member does not fit its quota",
    };
}
