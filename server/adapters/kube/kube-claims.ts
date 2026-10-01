// The claims of a unit's namespace as the relocation carrier needs them: which stand, and the one a
// StatefulSet makes for a pod it does not run yet, made by the Manager instead, because a consumer
// restore writes a generation's claim into a target rendered at replicas 0, where the StatefulSet has
// made none. Split from kube.ts along the 400-line budget, the way kube-namespace.ts is; these take the
// caller's own clients, so a slave's bearer and the master's ServiceAccount reach them as before.
import type { AppsV1Api, CoreV1Api, V1PersistentVolumeClaim, V1StatefulSet } from "@kubernetes/client-node";
import { isOrdinalClaim } from "./port.ts";
import { upstream } from "./kube.ts";

/** Every PVC name in the namespace — what the consumer dump tars and the restore writes into.
 *  NEEDS a live cluster. */
export async function listPersistentVolumeClaims(core: CoreV1Api, namespace: string): Promise<string[]> {
  try {
    const res = await core.listNamespacedPersistentVolumeClaim({ namespace });
    return res.items.map((p) => p.metadata?.name).filter((n): n is string => typeof n === "string");
  } catch (e) {
    throw upstream(`list PersistentVolumeClaims in ${namespace}`, e);
  }
}

/** `claim` as the StatefulSet whose volumeClaimTemplate names it would write it: the template's spec,
 *  labels and annotations, with the StatefulSet's selector labels, so the StatefulSet adopts it by name
 *  when it scales up. null where no StatefulSet of `statefulSets` names it. */
export function statefulSetClaimOf(statefulSets: readonly V1StatefulSet[], claim: string): V1PersistentVolumeClaim | null {
  for (const s of statefulSets) {
    for (const t of s.spec?.volumeClaimTemplates ?? []) {
      if (!t.metadata?.name || !s.metadata?.name || !isOrdinalClaim(`${t.metadata.name}-${s.metadata.name}`, claim)) continue;
      return {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: claim, labels: { ...t.metadata.labels, ...s.spec?.selector?.matchLabels }, ...(t.metadata.annotations ? { annotations: t.metadata.annotations } : {}) },
        ...(t.spec ? { spec: t.spec } : {}),
      };
    }
  }
  return null;
}

/** Create `claim` in `namespace` from the StatefulSet that names it (statefulSetClaimOf), and answer
 *  whether one did. It lists StatefulSets and creates the claim, and asks for nothing else: on master1
 *  the Manager may get neither a StatefulSet nor a claim, and may not delete a claim. NEEDS a live
 *  cluster. */
export async function createStatefulSetClaim(api: { apps: AppsV1Api; core: CoreV1Api }, namespace: string, claim: string): Promise<boolean> {
  let body: V1PersistentVolumeClaim | null;
  try {
    body = statefulSetClaimOf((await api.apps.listNamespacedStatefulSet({ namespace })).items, claim);
  } catch (e) {
    throw upstream(`list StatefulSets in ${namespace}`, e);
  }
  if (body === null) return false;
  try {
    await api.core.createNamespacedPersistentVolumeClaim({ namespace, body });
  } catch (e) {
    throw upstream(`create PersistentVolumeClaim ${namespace}/${claim}`, e);
  }
  return true;
}
