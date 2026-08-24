// gate-runner/src/gates/data-protection.gate.test.ts
import { describe, expect, it } from "vitest";
import { dataProtectionGate } from "./data-protection.gate.ts";
import type { GateContext, RenderedDoc } from "./gate.ts";

const GUARD = "argocd.argoproj.io/sync-options";
const FENCED = "Prune=false,Delete=false";

/** Build a rendered doc; `raw` is spread last so a test can inject a hostile/partial shape. */
function doc(kind: string, name: string, raw: Record<string, unknown>, docIndex = 0): RenderedDoc {
  return {
    env: "dev",
    docIndex,
    apiVersion: kind === "PersistentVolumeClaim" ? "v1" : "apps/v1",
    kind,
    name,
    namespace: "acme",
    raw: { apiVersion: raw.apiVersion ?? "v1", kind, metadata: { name }, ...raw },
  };
}

function pvc(name: string, annotations?: Record<string, string>, docIndex = 0): RenderedDoc {
  return doc(
    "PersistentVolumeClaim",
    name,
    { metadata: annotations ? { name, annotations } : { name } },
    docIndex,
  );
}

function makeCtx(rendered: RenderedDoc[]): GateContext {
  return {
    targetName: "acme",
    stage: "dev",
    chartPath: "deploy/chart",
    clusterValueFiles: [],
    files: new Map(),
    manifest: null,
    rendered,
    dependencies: [],
  };
}

describe("dataProtectionGate data protection", () => {
  it("passes when every PVC is fenced with Prune=false,Delete=false", () => {
    const r = dataProtectionGate.check(makeCtx([pvc("acme-data", { [GUARD]: FENCED })]));
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
    expect(r.expected).toContain("Prune=false,Delete=false");
  });

  it("passes with zero PVCs", () => {
    const r = dataProtectionGate.check(makeCtx([doc("Service", "acme-web", { spec: { type: "ClusterIP" } })]));
    expect(r.status).toBe("pass");
    expect(r.reason).toBeNull();
    expect(r.found).toContain("No standalone PersistentVolumeClaim");
  });

  it("passes and notes StatefulSet volumeClaimTemplates as Argo-exempt", () => {
    const sts = doc("StatefulSet", "acme-db", {
      spec: { volumeClaimTemplates: [{ metadata: { name: "data" } }] },
    });
    const r = dataProtectionGate.check(makeCtx([sts]));
    expect(r.status).toBe("pass");
    expect(r.found).toContain("StatefulSet volumeClaimTemplates");
    expect(r.found).toContain("acme-db");
  });

  // FAILURE MODE 1: a PVC with no sync-options annotation.
  it("fails a PVC with no sync-options annotation", () => {
    const r = dataProtectionGate.check(makeCtx([pvc("acme-data")]));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain("acme-data");
    expect(r.reason).toContain(`has no ${GUARD} annotation`);
    expect(r.evidence?.[0]).toMatchObject({
      source: "rendered",
      kind: "PersistentVolumeClaim",
      name: "acme-data",
    });
  });

  // FAILURE MODE 2: a PVC whose sync-options has only Prune=false (Delete=false missing).
  it("fails a PVC whose sync-options has only Prune=false", () => {
    const r = dataProtectionGate.check(makeCtx([pvc("acme-data", { [GUARD]: "Prune=false" })]));
    expect(r.status).toBe("fail");
    expect(r.reason).not.toBeNull();
    expect(r.reason).toContain("acme-data");
    expect(r.reason).toContain("missing Delete=false");
    expect(r.evidence?.[0]?.value).toBe("Prune=false");
  });

  it("does not crash on a hostile PVC whose metadata is a non-object", () => {
    const hostile = doc("PersistentVolumeClaim", "evil", {});
    hostile.raw = { metadata: "not-an-object" };
    const r = dataProtectionGate.check(makeCtx([hostile]));
    expect(r.status).toBe("fail");
    expect(r.reason).toContain(`has no ${GUARD} annotation`);
  });
});
