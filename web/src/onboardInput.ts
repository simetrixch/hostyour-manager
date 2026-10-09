import type { Stage } from "../../shared/enums.ts";
import type { UnitSize } from "#unit/shared/unit-size.ts";
import type { OnboardInput } from "./api.ts";

/** The three shapes of a unit the wizard onboards: one that deploys itself, one that only builds, and
 *  one that only runs CI. */
export type OnboardKind = "deployable" | "build-only" | "ci-only";

export interface OnboardFormFields {
  consumerName: string;
  repoURL: string;
  stage: string;
  clusterId: string;
  owner: string;
  chartPath: string;
  size: string;
}

/** The request a kind sends. A CI-only unit carries no stage, cluster, chart or size: it has no release
 *  to place, and the server refuses nothing it never reads. */
export function onboardInput(kind: OnboardKind, f: OnboardFormFields): OnboardInput {
  const base = { consumerName: f.consumerName.trim(), repoURL: f.repoURL.trim(), owner: f.owner.trim() };
  if (kind === "ci-only") return { form: "ci-only", ...base };
  return {
    ...base,
    stage: f.stage as Stage,
    ...(kind === "deployable" ? { clusterId: f.clusterId } : {}),
    ...(f.chartPath.trim() ? { chartPath: f.chartPath.trim() } : {}),
    size: f.size as UnitSize,
  };
}
