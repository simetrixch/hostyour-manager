import {setHeaderOptions, PatchStrategy, type CustomObjectsApi} from "@kubernetes/client-node";
import type {ArgoAppStatus, ArgoApplicationRow} from "./port.ts";
import {mapArgoStatus, mapApplications} from "./kube-map.ts";
import {ARGO, isNotFound, upstream} from "./kube.ts";

export async function refreshApplications(custom: CustomObjectsApi, namespace: string, names: readonly string[]): Promise<string[]> {
  const refreshed: string[] = [];
  for (const name of new Set(names)) {
    try {
      await custom.patchNamespacedCustomObject({ ...ARGO, namespace, name,
        body: { metadata: { annotations: { "argocd.argoproj.io/refresh": "hard" } } } },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch));
      refreshed.push(name);
    } catch (e) {
      if (!isNotFound(e)) throw upstream(`refresh Argo Application ${namespace}/${name}`, e);
    }
  }
  return refreshed;
}


export async function refreshApplicationSet(custom: CustomObjectsApi, namespace: string, name: string): Promise<void> {
  try {
    await custom.patchNamespacedCustomObject({ ...ARGO, plural: "applicationsets", namespace, name,
      body: { metadata: { annotations: { "argocd.argoproj.io/application-set-refresh": "true" } } } },
    setHeaderOptions("Content-Type", PatchStrategy.MergePatch));
  } catch (e) { throw upstream(`refresh Argo ApplicationSet ${namespace}/${name}`, e); }
}


export async function getApplication(custom: CustomObjectsApi, namespace: string, name: string): Promise<ArgoAppStatus | null> {
  let raw: unknown;
  try {
    raw = await custom.getNamespacedCustomObject({ ...ARGO, namespace, name });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw upstream(`get Argo Application ${namespace}/${name}`, e);
  }
  return mapArgoStatus(raw);
}


export async function listApplications(custom: CustomObjectsApi, namespace: string): Promise<ArgoApplicationRow[]> {
  let raw: unknown;
  try {
    raw = await custom.listNamespacedCustomObject({ ...ARGO, namespace });
  } catch (e) {
    throw upstream(`list Argo Applications in ${namespace}`, e);
  }
  return mapApplications((raw as { items?: unknown[] }).items ?? []);
}


