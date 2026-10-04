import { STAGE, type Stage } from "../../shared/enums.ts";

// A consumer gains a stage through its ordinary onboarding at that stage, which stands beside the
// others and writes its own registration and release pin. The Consumers card opens the onboard form
// with what the standing stage already states; the machine and the size are left for the operator,
// as for a tenant's Add stage, because a stage copied from another is how TEST ends up on PROD's machine.

interface StandingStage {
  name: string;
  repoUrl: string | null;
  chartPath: string | null;
}

export function addStageHref(standing: StandingStage, stage: Stage): string {
  const params = new URLSearchParams({ name: standing.name, repo: standing.repoUrl ?? "", stage });
  if (standing.chartPath) params.set("chartPath", standing.chartPath);
  return `/consumers/onboard?${params.toString()}`;
}

/** The form fields an Add stage link fills, or null where the URL names no stage to add. */
export function addStageForm(params: URLSearchParams): { consumerName: string; repoURL: string; stage: Stage; chartPath?: string } | null {
  const stage = STAGE.find((s) => s === params.get("stage"));
  const consumerName = params.get("name") ?? "";
  const repoURL = params.get("repo") ?? "";
  if (!stage || !consumerName || !repoURL) return null;
  const chartPath = params.get("chartPath");
  return { consumerName, repoURL, stage, ...(chartPath ? { chartPath } : {}) };
}
