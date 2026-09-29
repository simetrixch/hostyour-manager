import { describe, it, expect } from "vitest";
import { mapArgoStatus, claimUsersOf } from "./kube-map.ts";

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

describe("claimUsersOf (who a claim's files belong to)", () => {
  const pod = (securityContext: object, container: object) => ({
    spec: { securityContext, volumes: [{ name: "data", persistentVolumeClaim: { claimName: "postgres-data" } }, { name: "tmp" }], containers: [{ volumeMounts: [{ name: "data" }, { name: "tmp" }], ...container }] },
  });

  it("takes the pod's user and its fsGroup where no group is stated", () => {
    expect(claimUsersOf([pod({ runAsUser: 999, fsGroup: 999 }, {})])).toEqual([{ claim: "postgres-data", user: 999, group: 999 }]);
  });

  it("the container's own user and group come before the pod's", () => {
    expect(claimUsersOf([pod({ runAsUser: 1, fsGroup: 2 }, { securityContext: { runAsUser: 1000, runAsGroup: 1001 } })])).toEqual([{ claim: "postgres-data", user: 1000, group: 1001 }]);
  });

  it("THE INNOCENT NEIGHBOUR: a container stating no user gives no row, rather than a guessed one", () => {
    expect(claimUsersOf([pod({ fsGroup: 999 }, {})])).toEqual([]);
  });
});
