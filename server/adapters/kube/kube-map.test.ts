import { describe, it, expect } from "vitest";
import { mapArgoStatus, claimUsersOf, mapExternalSecrets } from "./kube-map.ts";

// What an Application's last comparison rendered, read off its status: the run that rewrites a
// standing tenant's member entries waits on these to tell the new entries from the old.

const sha = "a".repeat(40);

describe("mapArgoStatus, the rendered side", () => {
  it("maps what the last comparison rendered per source, and the namespace labels the spec asks for", () => {
    const s = mapArgoStatus({
      spec: { syncPolicy: { managedNamespaceMetadata: { labels: { "platform/tenant": "g1", odd: 3 } } } },
      status: {
        sync: {
          status: "Synced",
          revisions: [sha, sha],
          comparedTo: {
            sources: [
              { repoURL: "https://github.com/x/cat.git" },
              { repoURL: "https://github.com/x/cat.git", path: "charts/app", helm: { valueFiles: ["values.yaml", 7], valuesObject: { fullnameOverride: "app-erp" } } },
            ],
          },
        },
        health: { status: "Healthy" },
      },
    });
    expect(s.namespaceLabels).toEqual({ "platform/tenant": "g1" });
    expect(s.syncSources).toEqual([
      { repoURL: "https://github.com/x/cat.git", revision: sha },
      { repoURL: "https://github.com/x/cat.git", revision: sha, path: "charts/app", valueFiles: ["values.yaml"], valuesObject: { fullnameOverride: "app-erp" } },
    ]);
  });
});

describe("claimUsersOf (who a claim's files belong to, off the workload templates)", () => {
  const deployment = (securityContext: object, container: object) => ({
    metadata: { name: "postgres" },
    spec: { template: { spec: { securityContext, volumes: [{ name: "data", persistentVolumeClaim: { claimName: "postgres-data" } }, { name: "tmp" }], containers: [{ volumeMounts: [{ name: "data" }, { name: "tmp" }], ...container }] } } },
  });

  it("takes the pod's user and its fsGroup where no group is stated", () => {
    expect(claimUsersOf([deployment({ runAsUser: 999, fsGroup: 999 }, {})])).toEqual([{ claim: "postgres-data", ordinals: false, user: 999, group: 999 }]);
  });

  it("the container's own user and group come before the pod's", () => {
    expect(claimUsersOf([deployment({ runAsUser: 1, fsGroup: 2 }, { securityContext: { runAsUser: 1000, runAsGroup: 1001 } })])).toEqual([{ claim: "postgres-data", ordinals: false, user: 1000, group: 1001 }]);
  });

  it("a StatefulSet's claim template names the stem its pods' claims number from", () => {
    // queue-digita-post-mta-0 comes from the claim template `queue` of the StatefulSet `digita-post-mta`,
    // and a quiesced StatefulSet has no pod left to read it from.
    const mta = { metadata: { name: "digita-post-mta" }, spec: { volumeClaimTemplates: [{ metadata: { name: "queue" } }], template: { spec: { securityContext: { runAsUser: 1000, fsGroup: 1000 }, initContainers: [{ volumeMounts: [{ name: "queue" }] }], containers: [] } } } };
    expect(claimUsersOf([mta])).toEqual([{ claim: "queue-digita-post-mta", ordinals: true, user: 1000, group: 1000 }]);
  });

  it("THE INNOCENT NEIGHBOUR: a container stating no user gives no row, rather than a guessed one", () => {
    expect(claimUsersOf([deployment({ fsGroup: 999 }, {})])).toEqual([]);
  });
});

describe("mapExternalSecrets, the entries it reads", () => {
  it("names every distinct Vault entry the spec reads, once, in spec order", () => {
    const data = [{ remoteRef: { key: "test/tenants/g/google-translation" } }, { remoteRef: { key: "test/tenants/g" } }, { remoteRef: { key: "test/tenants/g/google-translation" } }, {}];
    expect(mapExternalSecrets([{ metadata: { name: "es" }, spec: { data } }])[0]?.remoteKeys).toEqual(["test/tenants/g/google-translation", "test/tenants/g"]);
  });
});
