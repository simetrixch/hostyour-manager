// gate-runner/src/render-docs.test.ts
// The List-expansion belt: a normal multi-doc stream keeps its docs 1:1, a `kind: List` (and a
// List nested inside a List) is flattened so no member hides inside it, and hostile shapes (a doc
// with no kind, an empty document, a bare scalar, a string where metadata belongs) are skipped or
// defaulted without ever throwing. docIndex is asserted to run 0,1,2,... over the EMITTED docs.
import { describe, expect, it } from "vitest";
import { parseRenderedDocs } from "./render-docs.ts";

describe("parseRenderedDocs", () => {
  // (1) a plain two-document stream is emitted 1:1 with correct kind/name/namespace/docIndex.
  it("emits one RenderedDoc per document in a plain stream", () => {
    const stream = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: acme
spec: {}
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
  namespace: acme
spec:
  type: ClusterIP
`;
    const docs = parseRenderedDocs(stream, "dev");
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      env: "dev",
      docIndex: 0,
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: "web",
      namespace: "acme",
    });
    expect(docs[1]).toMatchObject({
      env: "dev",
      docIndex: 1,
      apiVersion: "v1",
      kind: "Service",
      name: "web-svc",
      namespace: "acme",
    });
    // `raw` is the parsed object a gate reads arbitrary fields off.
    expect((docs[1]?.raw as { spec: { type: string } }).spec.type).toBe("ClusterIP");
  });

  // (2) a kind:List wrapping three members is flattened to three docs; the List wrapper is gone.
  it("flattens a kind:List into its members and drops the wrapper", () => {
    const stream = `
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Namespace
    metadata:
      name: smuggled
  - apiVersion: v1
    kind: Service
    metadata:
      name: svc
      namespace: acme
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: dep
      namespace: acme
`;
    const docs = parseRenderedDocs(stream, "prod");
    expect(docs.map((d) => d.kind)).toEqual(["Namespace", "Service", "Deployment"]);
    expect(docs.some((d) => d.kind === "List")).toBe(false);
    expect(docs.map((d) => d.docIndex)).toEqual([0, 1, 2]);
    expect(docs[0]).toMatchObject({ env: "prod", kind: "Namespace", name: "smuggled", namespace: "" });
    expect(docs[2]).toMatchObject({ kind: "Deployment", name: "dep", namespace: "acme" });
  });

  // (3) a List whose items contain a further List is fully flattened; no List survives at any depth.
  it("recursively flattens a List nested inside a List", () => {
    const stream = `
kind: List
apiVersion: v1
items:
  - kind: ConfigMap
    apiVersion: v1
    metadata:
      name: outer-cm
  - kind: ServiceList
    apiVersion: v1
    items:
      - kind: Service
        apiVersion: v1
        metadata:
          name: inner-svc
      - kind: Secret
        apiVersion: v1
        metadata:
          name: inner-secret
`;
    const docs = parseRenderedDocs(stream, "dev");
    expect(docs.map((d) => d.kind)).toEqual(["ConfigMap", "Service", "Secret"]);
    expect(docs.map((d) => d.name)).toEqual(["outer-cm", "inner-svc", "inner-secret"]);
    expect(docs.some((d) => d.kind.endsWith("List"))).toBe(false);
    expect(docs.map((d) => d.docIndex)).toEqual([0, 1, 2]);
  });

  // (4) a document with no `kind` and an empty document (---) are both skipped; the counter is dense.
  it("skips a doc with no kind and an empty document, keeping docIndex dense", () => {
    const stream = `
apiVersion: v1
metadata:
  name: no-kind-here
data:
  a: b
---
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: real
`;
    const docs = parseRenderedDocs(stream, "dev");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ docIndex: 0, kind: "ConfigMap", name: "real" });
  });

  // (5) a bare scalar / string document is skipped and does not crash the parser.
  it("skips a scalar string document without throwing", () => {
    const stream = `
"just a naked string"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ok
`;
    let docs: ReturnType<typeof parseRenderedDocs> | undefined;
    expect(() => {
      docs = parseRenderedDocs(stream, "dev");
    }).not.toThrow();
    expect(docs).toHaveLength(1);
    expect(docs?.[0]).toMatchObject({ kind: "ConfigMap", name: "ok", docIndex: 0 });
  });

  // (6) hostile: metadata is a string, not an object — name/namespace default to "" without throwing.
  it("defaults name/namespace to empty when metadata is not an object", () => {
    const stream = `
apiVersion: v1
kind: ConfigMap
metadata: "i am a string, not a map"
`;
    let docs: ReturnType<typeof parseRenderedDocs> | undefined;
    expect(() => {
      docs = parseRenderedDocs(stream, "dev");
    }).not.toThrow();
    expect(docs).toHaveLength(1);
    expect(docs?.[0]).toMatchObject({ kind: "ConfigMap", name: "", namespace: "" });
  });

  // (7) REGRESSION: the applier (k8s/ArgoCD unstructured.IsList) flattens ANY object with a top-level
  // items[] array, kind-agnostic. A `kind: Widget` wrapper (an unknown CRD kubeconform skips) must be
  // flattened too, else its members smuggle past every rendered-doc gate while ArgoCD deploys them.
  it("flattens ANY object carrying a top-level items array, regardless of its kind", () => {
    const stream = `
apiVersion: example.com/v1
kind: Widget
metadata:
  name: decoy
items:
  - apiVersion: v1
    kind: Namespace
    metadata:
      name: smuggled-ns
  - apiVersion: v1
    kind: Secret
    metadata:
      name: smuggled-secret
  - apiVersion: v1
    kind: Service
    metadata:
      name: smuggled-svc
    spec:
      type: NodePort
`;
    const docs = parseRenderedDocs(stream, "dev");
    expect(docs.map((d) => d.kind)).toEqual(["Namespace", "Secret", "Service"]);
    expect(docs.some((d) => d.kind === "Widget")).toBe(false);
  });

  // (8) REGRESSION: a kind-LESS wrapper with items[] is still flattened (the applier checks items, not
  // kind), so a member cannot hide behind an absent kind either.
  it("flattens a kind-less wrapper that carries an items array", () => {
    const stream = `
apiVersion: v1
items:
  - apiVersion: v1
    kind: Namespace
    metadata:
      name: hidden
`;
    const docs = parseRenderedDocs(stream, "dev");
    expect(docs.map((d) => d.kind)).toEqual(["Namespace"]);
  });
});
