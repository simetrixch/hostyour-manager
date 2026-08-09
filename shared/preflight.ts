// Preflight report shapes for the adopt Run. The check OUTCOME (`status`) is split from whether a
// failure BLOCKS adoption (`severity`), and the report carries the TOFU host key + timestamp. Shared
// so the web card and the server runner agree on one contract.

/** The outcome of a single check. */
export type PreflightStatus = "pass" | "warn" | "fail";

/** Whether a `fail` blocks. `hard` = adoption cannot produce a usable server (not Ubuntu,
 *  no sudo, no egress). `soft` = recorded as a warning on the server card and re-evaluated
 *  as `hard` by the provision preflight. */
export type PreflightSeverity = "hard" | "soft";

export interface PreflightCheck {
  id: string; // "os.ubuntu"
  title: string; // "Operating system"
  severity: PreflightSeverity;
  status: PreflightStatus;
  detail: string; // "ubuntu 26.04"
  hint?: string; // actionable fix shown on failure
}

export interface PreflightReport {
  /** SHA256:… of the host key, recorded trust-on-first-use at connect (adopt step 0). */
  hostKey?: string;
  /** epoch ms the checks ran. */
  checkedAt: number;
  checks: PreflightCheck[];
}

/** The adopt gate: only a HARD check that FAILED blocks. Soft fails ride along as warnings
 *  (they become hard at provision time). */
export function hasHardFailure(report: PreflightReport): boolean {
  return report.checks.some((c) => c.severity === "hard" && c.status === "fail");
}
