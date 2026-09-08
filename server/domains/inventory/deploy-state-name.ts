// The name of the ConfigMap attest-target reads has ONE statement in this process — DEPLOY_STATE in
// server/adapters/kube/kube.ts, which every onboarding, tenant creation and adoption fails closed on.
// Outside the process there is a MIRROR of it: `configmap.configmap.name` in the platform repo's
// clusters/inventories/deploy-state/values-common.yaml, which is the name GitOps actually writes into
// kube-system, and the same literal is the resourceName the Manager's own RBAC is scoped to.
//
// Nothing derives one from the other — they are two literals in two repositories — and a byte between
// them fails nothing where it is written. It produces a Manager that cannot attest a cluster that is
// perfectly provisioned: measured on the first consumer onboarding ever run against a real cluster
// (2026-09-09, run_01M21GY6CGY5HGG5R8SC4M80FP), where thirteen gates passed and the run then refused
// its target for a ConfigMap nothing had ever written under the name it asked for.
//
// It takes the SAME route to the platform repo the channel ceiling and the release grammar take — the
// PlatformRepo port and the trunk — so one way to the platform's own files, not a third.
//
// Boundary: domain layer — shared/ and the git PlatformRepo port only, like the two readers beside it.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { PRODUCT_BRANCH } from "../../../shared/branches.ts";
import { DEPLOY_STATE_CONFIGMAP } from "../../../shared/deploy-state.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";

/** The platform file whose values decide the name GitOps writes. */
export const DEPLOY_STATE_VALUES_PATH =
  "clusters/inventories/deploy-state/values-common.yaml";

/** The branch it is read from: the trunk, as the channel ceiling and the release grammar are. */
export const DEPLOY_STATE_VALUES_BRANCH = PRODUCT_BRANCH;

const DeployStateValuesFile = z.object({
  configmap: z
    .object({ configmap: z.object({ name: z.string().min(1) }) })
    .optional(),
});

/** The name the platform's chart writes, read off the trunk. */
export async function readDeployStateName(repo: PlatformRepo): Promise<string> {
  const raw = await repo.withBranch(DEPLOY_STATE_VALUES_BRANCH, (trunk) =>
    trunk.readFile(DEPLOY_STATE_VALUES_PATH),
  );
  if (raw === null)
    throw errNotFound(
      `${DEPLOY_STATE_VALUES_PATH} on the platform repo's ${DEPLOY_STATE_VALUES_BRANCH} branch`,
    );
  const parsed = DeployStateValuesFile.safeParse(parseYaml(raw));
  const name = parsed.success
    ? parsed.data.configmap?.configmap.name
    : undefined;
  if (name === undefined) {
    throw errValidation(
      `${DEPLOY_STATE_VALUES_PATH} carries no readable configmap.configmap.name — the name GitOps writes the deploy-state under is missing or malformed`,
    );
  }
  return name;
}

/** Refuses when the platform writes the deploy-state under a name this process does not read. */
export function assertMirrorsDeployStateName(written: string): void {
  if (written !== DEPLOY_STATE_CONFIGMAP.name) {
    throw errValidation(
      `the platform writes the deploy-state as "${written}" and this Manager reads "${DEPLOY_STATE_CONFIGMAP.name}" — ` +
        `every attest-target would refuse a cluster that is provisioned (${DEPLOY_STATE_VALUES_PATH} on ${DEPLOY_STATE_VALUES_BRANCH})`,
    );
  }
}
