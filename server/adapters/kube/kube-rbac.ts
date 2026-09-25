// The concrete BuildRbacWriter — a unit's build Roles + RoleBindings, written by the Manager because
// the unit's AppProject blacklists both kinds, so nothing the unit deploys through ArgoCD can create
// them. Which of them belong to the unit and which to the unit at ONE stage is stated where they are
// rendered (domains/units/build-rbac.ts); this writer applies and deletes whatever it is handed.
// A sibling of kube.ts rather than part of it: same adapter, same clients, its own file so neither
// grows past what one reader can hold. Master-local — the unit's `<name>-build` namespace and the
// ArgoCD namespace both live on the cluster this pod runs on. Like the other IO shells here it NEEDS a
// live cluster and is integration-tested there; the render is pure (domains/units/build-rbac.ts).
import { RbacAuthorizationV1Api } from "@kubernetes/client-node";
import type { BuildRbacWriter, BuildRbacGrant, BuildRbacObject, RoleManifest, RoleBindingManifest } from "./port.ts";
import { MANAGER_PROJECT_LABELS } from "./port.ts";
import { buildKubeConfig, isNotFound, upstream, type MasterKubeInput } from "./kube.ts";
import { isManagerOwned } from "./kube-map.ts";
import { errValidation } from "../../kernel/errors.ts";

export class KubeBuildRbacWriter implements BuildRbacWriter {
  private readonly rbac: RbacAuthorizationV1Api;

  constructor(input: MasterKubeInput) {
    this.rbac = buildKubeConfig(input).makeApiClient(RbacAuthorizationV1Api);
  }

  /** Role first, then its Binding: the Binding's roleRef would dangle the other way round. Idempotent
   *  (a crash-resumed onboard replaces both in place). */
  async applyBuildRbac(grants: readonly BuildRbacGrant[]): Promise<{ created: number }> {
    let created = 0;
    for (const { role, binding } of grants) {
      if (await this.applyRole(role)) created++;
      if (await this.applyBinding(binding)) created++;
    }
    return { created };
  }

  /** Binding first, then its Role — the reverse of the write order, so a half-deleted grant is never
   *  a Role somebody could still bind. Idempotent: an already-absent pair counts nothing. */
  async deleteBuildRbac(grants: readonly BuildRbacGrant[]): Promise<{ deleted: number }> {
    let deleted = 0;
    for (const { role, binding } of grants) {
      if (await this.deleteOne("RoleBinding", binding.metadata.namespace, binding.metadata.name)) deleted++;
      if (await this.deleteOne("Role", role.metadata.namespace, role.metadata.name)) deleted++;
    }
    return { deleted };
  }

  /** Which of these grants' objects are still there — the read the offboard orphan scan measures its
   *  own delete with. Both halves are asked about separately: a teardown that died between the
   *  Binding and the Role leaves the Role, and naming the pair would not say which is standing. */
  async listBuildRbac(grants: readonly BuildRbacGrant[]): Promise<BuildRbacObject[]> {
    const standing: BuildRbacObject[] = [];
    for (const { role, binding } of grants) {
      for (const o of [role, binding] as const) {
        if ((await this.read(o.kind, o.metadata.namespace, o.metadata.name)) !== null) {
          standing.push({ kind: o.kind, namespace: o.metadata.namespace, name: o.metadata.name });
        }
      }
    }
    return standing;
  }

  private async applyRole(role: RoleManifest): Promise<boolean> {
    const { name, namespace } = role.metadata;
    const existing = await this.read("Role", namespace, name);
    if (existing === null) {
      try {
        await this.rbac.createNamespacedRole({ namespace, body: role });
      } catch (e) {
        throw upstream(`create Role ${namespace}/${name}`, e);
      }
      return true;
    }
    assertManagerOwned("Role", namespace, name, existing);
    try {
      await this.rbac.replaceNamespacedRole({ name, namespace, body: withResourceVersion(role, existing) });
    } catch (e) {
      throw upstream(`replace Role ${namespace}/${name}`, e);
    }
    return false;
  }

  private async applyBinding(binding: RoleBindingManifest): Promise<boolean> {
    const { name, namespace } = binding.metadata;
    const existing = await this.read("RoleBinding", namespace, name);
    if (existing === null) {
      try {
        await this.rbac.createNamespacedRoleBinding({ namespace, body: binding });
      } catch (e) {
        throw upstream(`create RoleBinding ${namespace}/${name}`, e);
      }
      return true;
    }
    assertManagerOwned("RoleBinding", namespace, name, existing);
    try {
      await this.rbac.replaceNamespacedRoleBinding({ name, namespace, body: withResourceVersion(binding, existing) });
    } catch (e) {
      throw upstream(`replace RoleBinding ${namespace}/${name}`, e);
    }
    return false;
  }

  private async read(kind: "Role" | "RoleBinding", namespace: string, name: string): Promise<unknown> {
    try {
      return kind === "Role" ? await this.rbac.readNamespacedRole({ name, namespace }) : await this.rbac.readNamespacedRoleBinding({ name, namespace });
    } catch (e) {
      if (isNotFound(e)) return null;
      throw upstream(`get ${kind} ${namespace}/${name}`, e);
    }
  }

  private async deleteOne(kind: "Role" | "RoleBinding", namespace: string, name: string): Promise<boolean> {
    const existing = await this.read(kind, namespace, name);
    if (existing === null) return false;
    assertManagerOwned(kind, namespace, name, existing);
    try {
      if (kind === "Role") await this.rbac.deleteNamespacedRole({ name, namespace });
      else await this.rbac.deleteNamespacedRoleBinding({ name, namespace });
    } catch (e) {
      if (isNotFound(e)) return false; // raced with another delete — already gone
      throw upstream(`delete ${kind} ${namespace}/${name}`, e);
    }
    return true;
  }
}

/** Optimistic concurrency: a replace must carry the observed resourceVersion. It is not part of the
 *  render-time manifest types, so the wire body extends the manifest with it. */
function withResourceVersion<T extends { metadata: { name: string; namespace: string; labels: Record<string, string> } }>(manifest: T, existing: unknown): T {
  const resourceVersion = (existing as { metadata?: { resourceVersion?: string } }).metadata?.resourceVersion;
  return { ...manifest, metadata: { ...manifest.metadata, ...(resourceVersion !== undefined ? { resourceVersion } : {}) } };
}

/** Refuse to touch an object the Manager did not create. The names are per-unit, so a collision
 *  means something else claimed the name — overwriting it would silently change somebody's access. */
function assertManagerOwned(kind: string, namespace: string, name: string, existing: unknown): void {
  if (!isManagerOwned(existing)) {
    throw errValidation(
      `refusing to touch ${kind} "${name}" in ${namespace} — it is not Manager-managed (missing a Manager ownership label: ${MANAGER_PROJECT_LABELS.map((l) => `${l.key}=${l.value}`).join(" or ")})`,
    );
  }
}
