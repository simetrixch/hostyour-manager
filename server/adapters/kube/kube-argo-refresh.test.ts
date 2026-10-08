import { it, expect } from "vitest";
import type { CustomObjectsApi } from "@kubernetes/client-node";
import { mapArgoStatus } from "./kube-map.ts";
import { syncApplications } from "./kube-argo-refresh.ts";
import { ARGO } from "./kube.ts";

const sha = "a".repeat(40);

it("keeps a queued refresh visible, so old Synced/Healthy is not fresh proof", () => {
  const status = { sync: { status: "Synced", revision: sha }, health: { status: "Healthy" } };
  expect(mapArgoStatus({ metadata: { annotations: { "argocd.argoproj.io/refresh": "hard" } }, status }).refreshRequested).toBe(true);
  expect(mapArgoStatus({ metadata: { annotations: {} }, status }).refreshRequested).toBeUndefined();
});

it("syncApplications patches operation.sync.revision on each named Application and skips a 404", async () => {
  const calls: unknown[] = [];
  const custom = {
    patchNamespacedCustomObject: async (opts: unknown) => {
      const o = opts as { namespace: string; name: string; body: unknown };
      if (o.name === "app-missing") {
        const err = new Error("not found");
        (err as unknown as { statusCode: number }).statusCode = 404;
        throw err;
      }
      calls.push(opts);
      return {};
    },
  } as unknown as CustomObjectsApi;

  const synced = await syncApplications(custom, "argocd", ["app-1", "app-missing", "app-2"], sha);
  expect(synced).toEqual(["app-1", "app-2"]);
  expect(calls).toEqual([
    {
      ...ARGO,
      namespace: "argocd",
      name: "app-1",
      body: { operation: { initiatedBy: { username: "hostyour-manager" }, sync: { revision: sha } } },
    },
    {
      ...ARGO,
      namespace: "argocd",
      name: "app-2",
      body: { operation: { initiatedBy: { username: "hostyour-manager" }, sync: { revision: sha } } },
    },
  ]);
});

it("syncApplications throws upstream on non-404 error", async () => {
  const custom = {
    patchNamespacedCustomObject: async () => {
      throw new Error("connection reset");
    },
  } as unknown as CustomObjectsApi;

  await expect(syncApplications(custom, "argocd", ["app-1"], sha)).rejects.toMatchObject({
    code: "UPSTREAM",
    message: expect.stringContaining("sync Argo Application argocd/app-1 failed"),
  });
});

