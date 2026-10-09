import { describe, it, expect } from "vitest";
import type { AppsV1Api, CoreV1Api, CustomObjectsApi, V1PersistentVolumeClaim, V1StatefulSet } from "@kubernetes/client-node";
import { createStatefulSetClaim, listServiceClaims, statefulSetClaimOf } from "./kube-claims.ts";

// The claim the Manager makes in place of a StatefulSet at replicas 0 must be the one the StatefulSet
// would make, or it does not adopt it when it scales up: the name, the template's spec, and labels
// that carry the StatefulSet's selector.

const mta: V1StatefulSet = {
  metadata: { name: "mta" },
  spec: {
    serviceName: "mta",
    selector: { matchLabels: { app: "mta" } },
    template: { metadata: { labels: { app: "mta" } }, spec: { containers: [] } },
    volumeClaimTemplates: [{ metadata: { name: "queue", labels: { tier: "spool" } }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } }, storageClassName: "microk8s-hostpath" } }],
  },
};

describe("statefulSetClaimOf", () => {
  it("writes the claim of an ordinal as its StatefulSet would: the template's spec, its labels and the selector's", () => {
    expect(statefulSetClaimOf([mta], "queue-mta-0")).toEqual({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "queue-mta-0", labels: { tier: "spool", app: "mta" } },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } }, storageClassName: "microk8s-hostpath" },
    });
  });

  it("PLANTED INNOCENT: names no claim that only shares the stem, or that no template names", () => {
    expect(statefulSetClaimOf([mta], "queue-mta-0-old")).toBeNull();
    expect(statefulSetClaimOf([mta], "queue-mta")).toBeNull();
    expect(statefulSetClaimOf([mta], "cache-0")).toBeNull();
  });
});

describe("createStatefulSetClaim", () => {
  // The two clients it calls, stubbed: the StatefulSets it lists, and every claim it creates.
  function clients(statefulSets: V1StatefulSet[]): { created: { namespace: string; body: V1PersistentVolumeClaim }[]; api: { apps: AppsV1Api; core: CoreV1Api } } {
    const created: { namespace: string; body: V1PersistentVolumeClaim }[] = [];
    const apps = { listNamespacedStatefulSet: async () => ({ items: statefulSets }) };
    const core = { createNamespacedPersistentVolumeClaim: async (request: { namespace: string; body: V1PersistentVolumeClaim }) => { created.push(request); return request.body; } };
    return { created, api: { apps: apps as unknown as AppsV1Api, core: core as unknown as CoreV1Api } };
  }

  it("creates the claim a StatefulSet names, in its namespace, as statefulSetClaimOf writes it", async () => {
    const { created, api } = clients([mta]);
    expect(await createStatefulSetClaim(api, "acme-prod", "queue-mta-0")).toBe(true);
    expect(created).toEqual([{ namespace: "acme-prod", body: statefulSetClaimOf([mta], "queue-mta-0") }]);
  });

  it("PLANTED INNOCENT: creates nothing for a claim no StatefulSet names", async () => {
    const { created, api } = clients([mta]);
    expect(await createStatefulSetClaim(api, "acme-prod", "cache-0")).toBe(false);
    expect(created).toEqual([]);
  });
});

describe("listServiceClaims", () => {
  const custom = (list: (request: Record<string, unknown>) => Promise<unknown>) => ({ listNamespacedCustomObject: list }) as unknown as CustomObjectsApi;

  it("lists the names of the ServiceClaims of the namespace, from the platform group's served version", async () => {
    const asked: Record<string, unknown>[] = [];
    const api = custom(async (request) => { asked.push(request); return { items: [{ metadata: { name: "web-mongo" } }, { metadata: { name: "web-redis" } }, { metadata: {} }] }; });
    expect(await listServiceClaims(api, "acme-web-prod")).toEqual(["web-mongo", "web-redis"]);
    expect(asked).toEqual([{ group: "platform.hostyour.cloud", version: "v1alpha1", plural: "serviceclaims", namespace: "acme-web-prod" }]);
  });

  it("PLANTED INNOCENT: answers [] for a namespace that holds none", async () => {
    expect(await listServiceClaims(custom(async () => ({ items: [] })), "acme-web-prod")).toEqual([]);
  });

  it("PLANTED DEFECT: fails on a 404 and on a refusal instead of answering [], since a claim it never saw would lose its databases with the namespace", async () => {
    for (const code of [404, 403]) {
      const api = custom(async () => { throw Object.assign(new Error(`HTTP ${code}`), { code }); });
      await expect(listServiceClaims(api, "acme-web-prod")).rejects.toThrow(`kube: list ServiceClaims in acme-web-prod failed: HTTP ${code}`);
    }
  });
});
