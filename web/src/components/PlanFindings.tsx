import type { ReactNode } from "react";
import type { PreflightCheck } from "../../../shared/preflight.ts";

/** What the steps' probes measured before the approve (hostyour-manager#207), as the table the
 *  operator reads before typing anything: one row per finding, in step order, the mark first. A
 *  plan on this screen carries no hard failure — one refuses the plan at planning time — so what
 *  stands here is what passed, and what is worth a look (a warning, a soft failure) is marked as
 *  such and says why. Nothing here: the steps of this kind declare no probe yet, and the table
 *  says so rather than vanishing, so the absence of a measurement is never read as one that passed. */
export function PlanFindings(props: { findings: PreflightCheck[] }): ReactNode {
  const { findings } = props;
  if (findings.length === 0) {
    return <p className="muted">Nothing was measured before this approve: the steps of this run declare no probe.</p>;
  }
  return (
    <div className="table__wrap">
      <table className="table">
        <thead>
          <tr><th>Measured before the approve</th><th>Found</th></tr>
        </thead>
        <tbody>
          {findings.map((c) => (
            <tr key={c.id} className={c.status === "pass" ? "" : "findings__attention"}>
              <td>{mark(c)} {c.title}</td>
              <td>{c.detail}{c.status !== "pass" && c.hint ? ` — ${c.hint}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function mark(c: PreflightCheck): string {
  if (c.status === "pass") return "✓";
  if (c.status === "warn") return "△";
  return c.severity === "hard" ? "✗" : "△";
}

