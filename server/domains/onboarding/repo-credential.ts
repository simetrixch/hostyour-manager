// The per-unit ArgoCD repository credential, provisioned at onboard — rendered here and applied beside the
// AppProject, the admission policy and the build grants. The generated Application fetches the
// consumer's PRIVATE chart repo (its delivery branch deploy/<stage>), and ArgoCD authenticates that
// fetch through a Secret labeled `argocd.argoproj.io/secret-type: repository` in its own namespace.
// The Controller writes it imperatively with the unit's ONE PAT: the PAT lives in the sealed store
// and the local build Vault, neither of which the target's ESO reads, so no chart-rendered
// ExternalSecret could materialize it — the Controller is the only writer that holds the value.
//
// Pure: no IO. The writer (adapters/kube/kube-repo-credential.ts) applies what this renders; the
// step opens the sealed PAT, hands it in, and zeroes its buffer after.
import { CONSUMER_PROJECT_LABEL, type RepoCredentialManifest } from "../../adapters/kube/port.ts";

/** The Secret name of one unit's repository credential — `repo-<name>`, the naming the per-slave
 *  ArgoCD repo Secrets already use (repo-hostyour-cloud, repo-catalog), prefixed per unit. */
export function consumerRepoCredentialName(consumerName: string): string {
  return `repo-${consumerName}`;
}

/** The username every platform git-over-https credential authenticates as — GitHub ignores the
 *  username when a PAT is the password, and the platform pins one constant so every repository
 *  Secret reads the same (base/lib/deploy-argocd.sh ensure_argocd_repo_credential). */
export const REPO_CREDENTIAL_USERNAME = "hostyour-cloud";

/** THE label that makes an ArgoCD instance treat a Secret as a repository credential. */
const ARGOCD_REPOSITORY_LABEL = { key: "argocd.argoproj.io/secret-type", value: "repository" } as const;

export function renderConsumerRepoCredential(input: {
  consumerName: string;
  /** The ArgoCD namespace the unit's Applications live in — where the instance discovers repo Secrets. */
  argoNamespace: string;
  repoURL: string;
  /** The unit's ONE PAT, opened from the sealed store in-run. Rides only stringData.password. */
  pat: string;
}): RepoCredentialManifest {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: consumerRepoCredentialName(input.consumerName),
      namespace: input.argoNamespace,
      labels: {
        [ARGOCD_REPOSITORY_LABEL.key]: ARGOCD_REPOSITORY_LABEL.value,
        // The Controller ownership label — the writer refuses to touch a Secret without it.
        [CONSUMER_PROJECT_LABEL.key]: CONSUMER_PROJECT_LABEL.value,
      },
    },
    type: "Opaque",
    stringData: {
      type: "git",
      url: input.repoURL,
      username: REPO_CREDENTIAL_USERNAME,
      password: input.pat,
    },
  };
}
