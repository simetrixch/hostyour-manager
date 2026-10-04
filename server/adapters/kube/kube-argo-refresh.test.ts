import {it, expect} from "vitest";
import {mapArgoStatus} from "./kube-map.ts";
const sha = "a".repeat(40);

  it("keeps a queued refresh visible, so old Synced/Healthy is not fresh proof", () => {
    const status = { sync: { status: "Synced", revision: sha }, health: { status: "Healthy" } };
    expect(mapArgoStatus({ metadata: { annotations: { "argocd.argoproj.io/refresh": "hard" } }, status }).refreshRequested).toBe(true);
    expect(mapArgoStatus({ metadata: { annotations: {} }, status }).refreshRequested).toBeUndefined();
  });

