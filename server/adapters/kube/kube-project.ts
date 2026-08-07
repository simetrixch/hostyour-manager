// The MasterProjectWriter impl — split from kube.ts (which holds the two readers) purely along the
// 400-line budget; the guards and the access path are unchanged. The ONLY writing kube path of the
// Controller: the per-unit isolation AppProject in an ArgoCD namespace on the master host.
import { CustomObjectsApi } from "@kubernetes/client-node";
import type { MasterProjectWriter, AppProjectManifest } from "./port.ts";
import { CONTROLLER_PROJECT_LABELS } from "./port.ts";
import { errValidation } from "../../kernel/errors.ts";
import { assertWritableProjectName, isControllerOwned } from "./kube-map.ts";
import { buildKubeConfig, isNotFound, upstream, type MasterKubeInput } from "./kube.ts";

const APPPROJECT = { group: "argoproj.io", version: "v1alpha1", plural: "appprojects" } as const;

/** The Controller's ONLY writing kube client: the per-consumer isolation AppProject on the
 *  master's argocd namespace (the CR is master-local, over the pod SA's in-cluster
 *  access). Every
 *  method is guarded: it refuses a reserved platform project name (assertWritableProjectName) and
 *  refuses to update/delete a project that carries no Controller ownership label (isControllerOwned),
 *  so it fails closed and never touches a foreign/system project. NEEDS a live cluster —
 *  integration-tested on the live clusters; the guards are pure (kube-map.ts, unit-tested). */
export class KubeMasterProjectWriter implements MasterProjectWriter {
  private readonly custom: CustomObjectsApi;

  constructor(input: MasterKubeInput) {
    this.custom = buildKubeConfig(input).makeApiClient(CustomObjectsApi);
  }

  /** Idempotent create-or-update: a fresh consumer creates the project; a crash-resumed executor
   *  re-runs apply-appproject and replaces it (copying the observed resourceVersion for optimistic
   *  concurrency). Refuses a reserved name, and refuses to overwrite a non-consumer-owned project. */
  async applyAppProject(namespace: string, project: AppProjectManifest): Promise<{ created: boolean }> {
    const name = project.metadata.name;
    assertWritableProjectName(name);
    const existing = await this.getAppProject(namespace, name);
    if (existing === null) {
      try {
        await this.custom.createNamespacedCustomObject({ ...APPPROJECT, namespace, body: project });
      } catch (e) {
        throw upstream(`create AppProject ${namespace}/${name}`, e);
      }
      return { created: true };
    }
    if (!isControllerOwned(existing)) {
      throw errValidation(
        `refusing to overwrite AppProject "${name}" in ${namespace} — it is not Controller-managed (missing a Controller ownership label: ${CONTROLLER_PROJECT_LABELS.map((l) => `${l.key}=${l.value}`).join(" or ")})`,
      );
    }
    // Optimistic concurrency: a replace must carry the observed resourceVersion. It is not part of
    // AppProjectManifest (a render-time type), so the wire body extends the manifest with it.
    const resourceVersion = (existing as { metadata?: { resourceVersion?: string } }).metadata?.resourceVersion;
    const body = { ...project, metadata: { ...project.metadata, ...(resourceVersion !== undefined ? { resourceVersion } : {}) } };
    try {
      await this.custom.replaceNamespacedCustomObject({ ...APPPROJECT, namespace, name, body });
    } catch (e) {
      throw upstream(`replace AppProject ${namespace}/${name}`, e);
    }
    return { created: false };
  }

  /** Idempotent delete: an already-absent project resolves { deleted: false }. Refuses a reserved
   *  name, and refuses to delete a project that is not consumer-owned. */
  async deleteAppProject(namespace: string, name: string): Promise<{ deleted: boolean }> {
    assertWritableProjectName(name);
    const existing = await this.getAppProject(namespace, name);
    if (existing === null) return { deleted: false };
    if (!isControllerOwned(existing)) {
      throw errValidation(
        `refusing to delete AppProject "${name}" in ${namespace} — it is not Controller-managed (missing a Controller ownership label: ${CONTROLLER_PROJECT_LABELS.map((l) => `${l.key}=${l.value}`).join(" or ")})`,
      );
    }
    try {
      await this.custom.deleteNamespacedCustomObject({ ...APPPROJECT, namespace, name });
    } catch (e) {
      if (isNotFound(e)) return { deleted: false }; // raced with another delete — already gone
      throw upstream(`delete AppProject ${namespace}/${name}`, e);
    }
    return { deleted: true };
  }

  /** Does the project still stand? Unguarded on purpose, unlike the two writes: a read changes
   *  nothing, and refusing to LOOK at a project because it carries no ownership label would hide
   *  exactly the collision the guards exist to surface. */
  async appProjectExists(namespace: string, name: string): Promise<boolean> {
    return (await this.getAppProject(namespace, name)) !== null;
  }

  /** GET the raw AppProject, mapping a 404 to null (the 1.x custom-objects API returns the object
   *  directly, so metadata.labels / metadata.resourceVersion read off the result). */
  private async getAppProject(namespace: string, name: string): Promise<unknown> {
    try {
      return await this.custom.getNamespacedCustomObject({ ...APPPROJECT, namespace, name });
    } catch (e) {
      if (isNotFound(e)) return null;
      throw upstream(`get AppProject ${namespace}/${name}`, e);
    }
  }
}

