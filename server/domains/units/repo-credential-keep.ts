// A unit's ArgoCD repository access, written by ONE rule wherever a run provisions it: the
// onboarding's provision-repo-credential and the relocation's provision-target. The App-token refresh
// tick holds the App half of the rule on every live unit (repo-credential-sweep.ts).
import type { CredentialStore, UseContext } from "../../security/store.ts";
import type { RepoCredentialWriter } from "../../adapters/kube/port.ts";
import type { Stage } from "../../../shared/enums.ts";
import { consumerRepoCredentialName, renderConsumerRepoCredential } from "./repo-credential.ts";

export type KeptRepoCredential = { identity: "github-app"; removed: boolean } | { identity: "pat"; created: boolean };

/** Keep ONE unit's ArgoCD repository access standing.
 *
 *  THE APP: a unit its owner's GitHub App reaches carries no repository Secret of its own. ArgoCD
 *  reads its repository through the credential template hostyour-cloud renders from Vault into every
 *  ArgoCD namespace (repo-creds-owner) and mints its tokens itself. A repository Secret here would
 *  shadow that template with an installation token that dies within the hour — measured on
 *  master.digitacloud.app, where digita-post's Application fell into ComparisonError an hour after its
 *  onboarding — so a standing one is taken away.
 *
 *  A PAT: a repository the App does not reach is fetched with its owner's PAT, written into the
 *  unit's repository Secret — replaced in place where one stands. */
export async function keepUnitRepoCredential(
  deps: { store: Pick<CredentialStore, "list" | "open">; repoCredential: Pick<RepoCredentialWriter, "applyRepoCredential" | "deleteRepoCredential"> },
  unit: { name: string; stage: Stage; repoURL: string; credentialId: string; argoNamespace: string },
  use: UseContext,
): Promise<KeptRepoCredential> {
  const name = consumerRepoCredentialName(unit.name, unit.stage);
  if ((await deps.store.list({ kind: "github-app" })).some((row) => row.id === unit.credentialId)) {
    const { deleted } = await deps.repoCredential.deleteRepoCredential(unit.argoNamespace, name);
    return { identity: "github-app", removed: deleted };
  }
  const pat = await deps.store.open(unit.credentialId, use);
  try {
    const { created } = await deps.repoCredential.applyRepoCredential(
      renderConsumerRepoCredential({ consumerName: unit.name, stage: unit.stage, argoNamespace: unit.argoNamespace, repoURL: unit.repoURL, pat: pat.toString("utf8") }),
    );
    return { identity: "pat", created };
  } finally {
    pat.fill(0);
  }
}
