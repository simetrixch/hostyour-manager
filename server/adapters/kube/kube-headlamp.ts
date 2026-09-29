// The concrete HeadlampKubeconfig — the Secret the shared Headlamp mounts its slave contexts from, and
// the restart that makes it read them. Master-local, like the repository credential beside it. The
// names are the ones the installation writes: the namespace and the release of deploy-platform-
// services' helm_release row (hostyour-deploy), the Secret and the key clusters/bootstrap/headlamp
// mounts, and the Secret its client secret stands in (hostyour-cloud). Like the other IO shells it
// needs a live cluster; what it writes is composed in domains/inventory/headlamp-contexts.ts.
import { AppsV1Api, CoreV1Api, PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import type { HeadlampKubeconfig, HeadlampSignIn } from "./port.ts";
import { buildKubeConfig, isNotFound, upstream, type MasterKubeInput } from "./kube.ts";
import { errValidation } from "../../kernel/errors.ts";

const NAMESPACE = "headlamp";
const DEPLOYMENT = "headlamp";
const KUBECONFIG_SECRET = "kube-slaves-kubeconfig";
const KUBECONFIG_KEY = "kubeconfig";
const SIGN_IN_SECRET = "headlamp-oidc";
/** The annotation `kubectl rollout restart` stamps on a pod template, which replaces the pods. */
const RESTARTED_AT = "kubectl.kubernetes.io/restartedAt";

const decoded = (b64: string | undefined): string | undefined => (b64 === undefined ? undefined : Buffer.from(b64, "base64").toString("utf8"));

export class KubeHeadlampKubeconfig implements HeadlampKubeconfig {
  private readonly core: CoreV1Api;
  private readonly apps: AppsV1Api;

  constructor(input: MasterKubeInput) {
    const kc = buildKubeConfig(input);
    this.core = kc.makeApiClient(CoreV1Api);
    this.apps = kc.makeApiClient(AppsV1Api);
  }

  async readSignIn(): Promise<HeadlampSignIn> {
    let env: Map<string, string>;
    let secret: string | undefined;
    try {
      const deployment = await this.apps.readNamespacedDeployment({ name: DEPLOYMENT, namespace: NAMESPACE });
      env = new Map((deployment.spec?.template.spec?.containers[0]?.env ?? []).map((e) => [e.name, e.value ?? ""]));
      secret = decoded((await this.core.readNamespacedSecret({ name: SIGN_IN_SECRET, namespace: NAMESPACE })).data?.["OIDC_CLIENT_SECRET"]);
    } catch (e) {
      throw upstream(`read Headlamp's sign-in in ${NAMESPACE}`, e);
    }
    const named = (key: string, value: string | undefined): string => {
      if (!value) throw errValidation(`Headlamp in ${NAMESPACE} is given no ${key}, so a slave context has nothing to sign the person in with`);
      return value;
    };
    return {
      issuerUrl: named("OIDC_ISSUER_URL", env.get("OIDC_ISSUER_URL")),
      clientId: named("OIDC_CLIENT_ID", env.get("OIDC_CLIENT_ID")),
      scopes: named("OIDC_SCOPES", env.get("OIDC_SCOPES")),
      clientSecret: named(`OIDC_CLIENT_SECRET in the Secret ${SIGN_IN_SECRET}`, secret),
    };
  }

  async readKubeconfig(): Promise<string | null> {
    try {
      return decoded((await this.core.readNamespacedSecret({ name: KUBECONFIG_SECRET, namespace: NAMESPACE })).data?.[KUBECONFIG_KEY]) ?? null;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw upstream(`read the Secret ${NAMESPACE}/${KUBECONFIG_SECRET}`, e);
    }
  }

  async writeKubeconfig(kubeconfig: string): Promise<void> {
    const body = { metadata: { name: KUBECONFIG_SECRET, namespace: NAMESPACE }, type: "Opaque", stringData: { [KUBECONFIG_KEY]: kubeconfig } };
    try {
      if ((await this.readKubeconfig()) === null) await this.core.createNamespacedSecret({ namespace: NAMESPACE, body });
      else await this.core.replaceNamespacedSecret({ name: KUBECONFIG_SECRET, namespace: NAMESPACE, body });
      await this.apps.patchNamespacedDeployment(
        { name: DEPLOYMENT, namespace: NAMESPACE, body: { spec: { template: { metadata: { annotations: { [RESTARTED_AT]: new Date().toISOString() } } } } } },
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      );
    } catch (e) {
      throw upstream(`write the Secret ${NAMESPACE}/${KUBECONFIG_SECRET} and restart Headlamp`, e);
    }
  }
}
