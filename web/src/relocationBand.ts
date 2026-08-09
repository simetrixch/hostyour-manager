// The relocation state band: a unit that is mid-backup/-restore/-move must SAY so where
// the operator looks at it, driven by the ONE shared runs table — an open relocation run (or the
// most recent failed one) surfaces as a line on the unit's card, linking to the Run screen. The
// same rule the server cards use (Servers.tsx relevantRun), scoped to the relocation kinds and the
// unit's own targetId — every relocation run targets its unit (targetKind app/tenant), so the id
// filter is exact here where it would be wrong for onboard/create-tenant.
import type { RunKind } from "../../shared/enums.ts";
import type { RunView } from "../../shared/api-types.ts";

const OPEN_RUN: ReadonlyArray<RunView["status"]> = ["planning", "planned", "approved", "running"];

const RELOCATION_KINDS: ReadonlySet<RunKind> = new Set<RunKind>(["backup", "restore", "migrate", "tenant-backup", "tenant-restore", "tenant-migrate"]);

/** The relocation run this unit's card must surface (listRuns is newest-first): an OPEN one — a
 *  planned move waiting for approval must never be invisible — else the most recent FAILED one
 *  (retry/skip live on the run screen). Undefined ⇒ no band. */
export function relocationRun(unitTargetId: string, runs: RunView[]): RunView | undefined {
  const own = runs.filter((r) => RELOCATION_KINDS.has(r.kind) && r.targetId === unitTargetId);
  return own.find((r) => OPEN_RUN.includes(r.status)) ?? (own[0]?.status === "failed" ? own[0] : undefined);
}

/** The band's one sentence — the verb in plain words (a migrate is a MOVE to the operator). */
export function relocationLine(run: RunView): string {
  const noun = run.kind === "migrate" || run.kind === "tenant-migrate" ? "move" : run.kind === "restore" || run.kind === "tenant-restore" ? "restore" : "backup";
  if (run.status === "planned") return `A ${noun} is planned — approve it`;
  if (run.status === "running") return `A ${noun} is running — watch it`;
  if (run.status === "failed") return `The last ${noun} failed — open it to retry`;
  return `A ${noun} is ${run.status}`; // planning | approved — moments from running
}
