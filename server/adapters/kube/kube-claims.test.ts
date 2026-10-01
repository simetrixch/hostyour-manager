import { describe, it, expect } from "vitest";
import type { V1StatefulSet } from "@kubernetes/client-node";
import { statefulSetClaimOf } from "./kube-claims.ts";

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
