// The namespace operations of KubeClusterReader — split from kube.ts (which holds the two readers)
// purely along the 400-line budget, the same way kube-project.ts and kube-rbac.ts were. The access
// path is unchanged: these take the caller's own CoreV1Api, so a slave's harvested bearer and the
// master's pod ServiceAccount both reach them exactly as before.
//
// Free functions rather than a class: unlike the AppProject writer these are METHODS of a reader
// that also does other things, so the reader keeps its interface and delegates one line each.
import { CoreV1Api, setHeaderOptions, PatchStrategy } from "@kubernetes/client-node";
import { AppError } from "../../kernel/errors.ts";
import { isNotFound, upstream } from "./kube.ts";

/** Offboard teardown — delete a target-cluster namespace (== the consumer name, G1). Idempotent:
 *  a 404 (already gone — a re-run, or ArgoCD/an operator removed it) resolves { deleted: false }.
 *  Non-blocking: propagationPolicy "Background" lets the API return immediately while the garbage
 *  collector reaps the namespace's children asynchronously — the executor never blocks on finalizers
 *  (the `--wait=false` equivalent). NEEDS a live cluster — integration-tested on the live clusters. */
export async function deleteNamespace(core: CoreV1Api, name: string): Promise<{ deleted: boolean }> {
  try {
    await core.deleteNamespace({ name, propagationPolicy: "Background" });
  } catch (e) {
    if (isNotFound(e)) return { deleted: false }; // already gone — the idempotent re-run no-op
    throw upstream(`delete namespace ${name}`, e);
  }
  return { deleted: true };
}

/** What the namespace IS, not what was asked of it. deleteNamespace above returns the moment the API
 *  ACCEPTS the delete, so its `deleted: true` means "asked", never "gone" — a finalizer on anything
 *  inside leaves the namespace Terminating with all of it still there. status.phase carries that
 *  state until the last finalizer is released; a 404 is the real absence. */
export async function namespacePhase(core: CoreV1Api, name: string): Promise<"absent" | "terminating" | "active"> {
  try {
    const ns = await core.readNamespace({ name });
    return ns.status?.phase === "Terminating" ? "terminating" : "active";
  } catch (e) {
    if (isNotFound(e)) return "absent";
    throw upstream(`read namespace ${name}`, e);
  }
}

/** A namespace's annotations, or null when it is absent — the read half of annotateNamespace below.
 *  An annotation-less namespace answers {} rather than null, so the caller can tell "no marks" from
 *  "no namespace": one is a namespace nothing holds, the other is nothing at all. */
export async function readNamespaceAnnotations(core: CoreV1Api, name: string): Promise<Record<string, string> | null> {
  try {
    const ns = await core.readNamespace({ name });
    return ns.metadata?.annotations ?? {};
  } catch (e) {
    if (isNotFound(e)) return null;
    throw upstream(`read namespace ${name}`, e);
  }
}

/** Every namespace carrying the label selector, by name — the read a tenant teardown reaps its member
 *  namespaces through. NEEDS a live cluster — integration-tested on the live clusters. */
export async function listNamespaces(core: CoreV1Api, labelSelector: string): Promise<string[]> {
  try {
    const res = await core.listNamespace({ labelSelector });
    return res.items.map((ns) => ns.metadata?.name).filter((n): n is string => typeof n === "string");
  } catch (e) {
    throw upstream(`list namespaces (${labelSelector})`, e);
  }
}

/** Merge-patch a namespace's annotations (null removes a key — JSON merge patch semantics). Fails
 *  NOT_FOUND on an absent namespace: the mark has to be STANDING when the claim cascade arrives, so
 *  marking nothing must never read as success. Only the keys handed in are sent, so ArgoCD's own
 *  managedNamespaceMetadata keys on the same namespace are left as they are. NEEDS a live cluster —
 *  integration-tested on the live clusters. */
export async function annotateNamespace(core: CoreV1Api, name: string, annotations: Record<string, string | null>): Promise<void> {
  try {
    await core.patchNamespace(
      { name, body: { metadata: { annotations } } },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
  } catch (e) {
    if (isNotFound(e)) throw new AppError("NOT_FOUND", `namespace ${name} not found — nothing to annotate`);
    throw upstream(`annotate namespace ${name}`, e);
  }
}
