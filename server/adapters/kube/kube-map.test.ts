import { describe, it, expect } from "vitest";
import { mapArgoStatus } from "./kube-map.ts";

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
