// The concrete RepoCredentialWriter — the per-unit ArgoCD repository Secret the Controller writes
// imperatively at onboarding and deletes at offboard/purge. A sibling of kube-rbac.ts rather than
// part of kube.ts: same adapter, same clients, its own file so neither grows past what one reader can
// hold. Master-local — every ArgoCD instance's namespace (the master's "argocd", a slave's per-slave
// namespace) lives on the cluster this pod runs on. Like the other IO shells it NEEDS a live cluster
// and is integration-tested there; the render is pure (domains/onboarding/repo-credential.ts).
import { CoreV1Api } from "@kubernetes/client-node";
import type { RepoCredentialWriter, RepoCredentialManifest } from "./port.ts";
import { CONTROLLER_PROJECT_LABELS } from "./port.ts";
import { buildKubeConfig, isNotFound, upstream, type MasterKubeInput } from "./kube.ts";
import { isControllerOwned } from "./kube-map.ts";
import { errValidation } from "../../kernel/errors.ts";

export class KubeRepoCredentialWriter implements RepoCredentialWriter {
  private readonly core: CoreV1Api;

  constructor(input: MasterKubeInput) {
    this.core = buildKubeConfig(input).makeApiClient(CoreV1Api);
  }

  async applyRepoCredential(secret: RepoCredentialManifest): Promise<{ created: boolean }> {
    const { name, namespace } = secret.metadata;
    const existing = await this.read(namespace, name);
    if (existing === null) {
      try {
        await this.core.createNamespacedSecret({ namespace, body: secret });
      } catch (e) {
        throw upstream(`create Secret ${namespace}/${name}`, e);
      }
      return { created: true };
    }
    assertControllerOwned(namespace, name, existing);
    try {
      const resourceVersion = (existing as { metadata?: { resourceVersion?: string } }).metadata?.resourceVersion;
      await this.core.replaceNamespacedSecret({
        name,
        namespace,
        body: { ...secret, metadata: { ...secret.metadata, ...(resourceVersion !== undefined ? { resourceVersion } : {}) } },
      });
    } catch (e) {
      throw upstream(`replace Secret ${namespace}/${name}`, e);
    }
    return { created: false };
  }

  async deleteRepoCredential(namespace: string, name: string): Promise<{ deleted: boolean }> {
    const existing = await this.read(namespace, name);
    if (existing === null) return { deleted: false };
    assertControllerOwned(namespace, name, existing);
    try {
      await this.core.deleteNamespacedSecret({ name, namespace });
    } catch (e) {
      if (isNotFound(e)) return { deleted: false }; // raced with another delete — already gone
      throw upstream(`delete Secret ${namespace}/${name}`, e);
    }
    return { deleted: true };
  }

  /** Does the Secret still stand? Unguarded like the project writer's presence read: looking costs
   *  nothing and an ownership check here would hide a name collision instead of reporting it. */
  async repoCredentialExists(namespace: string, name: string): Promise<boolean> {
    return (await this.read(namespace, name)) !== null;
  }

  private async read(namespace: string, name: string): Promise<unknown> {
    try {
      return await this.core.readNamespacedSecret({ name, namespace });
    } catch (e) {
      if (isNotFound(e)) return null;
      throw upstream(`get Secret ${namespace}/${name}`, e);
    }
  }
}

/** Refuse to touch a Secret the Controller did not create. The name is per-unit, so a collision means
 *  something else claimed it — replacing it would silently swap somebody's credential. */
function assertControllerOwned(namespace: string, name: string, existing: unknown): void {
  if (!isControllerOwned(existing)) {
    throw errValidation(
      `refusing to touch Secret "${name}" in ${namespace} — it is not Controller-managed (missing a Controller ownership label: ${CONTROLLER_PROJECT_LABELS.map((l) => `${l.key}=${l.value}`).join(" or ")})`,
    );
  }
}
