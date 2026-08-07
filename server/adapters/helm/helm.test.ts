// Unit coverage for the HelmRenderer flatten/parse mapping (parseHelmDocs) — the load-bearing
// logic gateT3Isolation rests on. The live `helm template` shell is integration-tested on the
// live clusters, so these tests feed hand-built multi-document streams (exactly what helm emits) and assert
// the flattening: List/aggregate unwrap is kind-agnostic, nested wrappers recurse, untrusted shapes
// degrade instead of crashing, and the field mapping (apiVersion/kind/name/namespace/raw) is exact.
// FakeHelmRenderer is covered too, since the domain tests script it.
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseHelmDocs, helmTemplateArgs } from "./helm.ts";
import { FakeHelmRenderer } from "./testing/fake.ts";
import type { HelmRenderResult } from "./port.ts";

describe("parseHelmDocs", () => {
  it("maps apiVersion/kind/name/namespace/raw across a multi-document stream", () => {
    const stream = [
      "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: e2e8ymj86dk8",
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: example-auth-backend\n  namespace: e2e8ymj86dk8",
    ].join("\n---\n");

    const docs = parseHelmDocs(stream);

    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ apiVersion: "v1", kind: "Namespace", name: "e2e8ymj86dk8", namespace: "" });
    expect(docs[1]).toMatchObject({
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: "example-auth-backend",
      namespace: "e2e8ymj86dk8",
    });
    // raw carries the parsed object so a gate can read arbitrary fields off it.
    expect(docs[1]?.raw).toMatchObject({ kind: "Deployment", metadata: { namespace: "e2e8ymj86dk8" } });
  });

  it("flattens a kind: List aggregate into its items and drops the wrapper", () => {
    const stream =
      "apiVersion: v1\nkind: List\nitems:\n" +
      "  - apiVersion: v1\n    kind: Service\n    metadata:\n      name: a\n" +
      "  - apiVersion: v1\n    kind: ConfigMap\n    metadata:\n      name: b\n";

    const docs = parseHelmDocs(stream);

    expect(docs.map((d) => d.kind)).toEqual(["Service", "ConfigMap"]);
    expect(docs.some((d) => d.kind === "List")).toBe(false);
  });

  it("unwraps an aggregate KIND-AGNOSTICALLY (a non-*List kind, and a kind-less wrapper)", () => {
    const widget =
      "apiVersion: example.com/v1\nkind: Widget\nitems:\n" +
      "  - apiVersion: v1\n    kind: Secret\n    metadata:\n      name: smuggled\n";
    const kindless = "items:\n  - apiVersion: v1\n    kind: Namespace\n    metadata:\n      name: t-other\n";

    const fromWidget = parseHelmDocs(widget);
    expect(fromWidget.map((d) => d.kind)).toEqual(["Secret"]);
    expect(fromWidget.some((d) => d.kind === "Widget")).toBe(false);

    const fromKindless = parseHelmDocs(kindless);
    expect(fromKindless.map((d) => d.kind)).toEqual(["Namespace"]);
  });

  it("recurses through nested List wrappers", () => {
    const stream =
      "kind: List\nitems:\n" +
      "  - kind: List\n    items:\n" +
      "      - apiVersion: v1\n        kind: Service\n        metadata:\n          name: deep\n";

    const docs = parseHelmDocs(stream);

    expect(docs.map((d) => d.kind)).toEqual(["Service"]);
    expect(docs[0]?.name).toBe("deep");
  });

  it("skips documents that have no kind and no items", () => {
    const stream = ["metadata:\n  name: orphan", "apiVersion: v1\nkind: Service\nmetadata:\n  name: real"].join("\n---\n");

    const docs = parseHelmDocs(stream);

    expect(docs.map((d) => d.kind)).toEqual(["Service"]);
  });

  it("skips empty / null / comment-only documents (helm's leading '---' and trailing blanks)", () => {
    const stream = "---\n# a comment only\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: only\n---\n";

    const docs = parseHelmDocs(stream);

    expect(docs).toHaveLength(1);
    expect(docs[0]?.name).toBe("only");
  });

  it("degrades a missing / non-string / non-object metadata to empty name & namespace", () => {
    const stream = [
      "apiVersion: v1\nkind: Service", // no metadata at all
      "apiVersion: v1\nkind: Service\nmetadata: not-an-object", // scalar where an object is expected
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: 12345", // numeric name is not a string
    ].join("\n---\n");

    const docs = parseHelmDocs(stream);

    expect(docs).toHaveLength(3);
    for (const d of docs) {
      expect(d.name).toBe("");
      expect(d.namespace).toBe("");
    }
  });

  it("defaults apiVersion to empty when it is absent or not a string", () => {
    const docs = parseHelmDocs("kind: Service\nmetadata:\n  name: x");
    expect(docs[0]?.apiVersion).toBe("");
  });

  it("fails closed on a document that cannot be materialised (alias bomb → no docs, never throws)", () => {
    // yaml's toJS resolves aliases and throws past its default maxAliasCount; that document is
    // treated as "does not exist" rather than taking the render down. A trailing valid doc still parses.
    const bomb =
      "a: &a [x,x,x,x,x,x,x,x,x,x]\n" +
      "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\n" +
      "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\n" +
      "d: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\n" +
      "kind: Bomb\n";
    const stream = `${bomb}---\napiVersion: v1\nkind: Service\nmetadata:\n  name: survivor\n`;

    const docs = parseHelmDocs(stream);

    expect(docs.map((d) => d.kind)).toEqual(["Service"]);
    expect(docs[0]?.name).toBe("survivor");
  });

  it("returns no docs for an empty stream", () => {
    expect(parseHelmDocs("")).toEqual([]);
    expect(parseHelmDocs("\n\n")).toEqual([]);
  });

  it("does not treat a scalar or absent `items` as an aggregate", () => {
    // A workload whose spec has an `items`-named STRING must not be mistaken for a List wrapper.
    const stream = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  items: not-a-list\n";
    const docs = parseHelmDocs(stream);
    expect(docs.map((d) => d.kind)).toEqual(["ConfigMap"]);
  });
});

describe("helmTemplateArgs", () => {
  const req = {
    workdir: "/wd",
    chartPath: "charts/example-auth",
    valueFiles: ["values.yaml", "values-prod.yaml"],
    releaseName: "zsjs023ctne0-auth",
    namespace: "zsjs023ctne0-auth",
  };

  it("joins every CHART-relative valueFile onto chartPath (ArgoCD helm-source semantics)", () => {
    // The cwd is the REPO-root workdir, so a bare `-f values.yaml` resolves there and helm fails
    // with "open values.yaml: no such file" for EVERY fan-out member (confirmed live) — the join
    // is load-bearing, not cosmetic.
    const args = helmTemplateArgs(req);
    expect(args).toEqual([
      "template", "zsjs023ctne0-auth", "charts/example-auth", "--namespace", "zsjs023ctne0-auth", "--include-crds",
      "-f", join("charts/example-auth", "values.yaml"),
      "-f", join("charts/example-auth", "values-prod.yaml"),
    ]);
    expect(args).not.toContain("values.yaml"); // never the bare, workdir-relative name
  });

  it("layers the staged valuesObject override file LAST (highest precedence), un-joined", () => {
    const args = helmTemplateArgs(req, "/tmp/example-helm-x/override.yaml");
    expect(args.slice(-2)).toEqual(["-f", "/tmp/example-helm-x/override.yaml"]); // absolute temp path, after the chart layers
  });
});

describe("FakeHelmRenderer", () => {
  it("records every request verbatim", async () => {
    const fake = new FakeHelmRenderer();
    await fake.template({
      workdir: "/wd",
      chartPath: "charts/example-auth",
      valueFiles: ["values.yaml", "values-dev.yaml"],
      releaseName: "e2e8ymj86dk8-auth",
      namespace: "e2e8ymj86dk8-auth",
    });

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      chartPath: "charts/example-auth",
      valueFiles: ["values.yaml", "values-dev.yaml"],
      releaseName: "e2e8ymj86dk8-auth",
      namespace: "e2e8ymj86dk8-auth",
    });
  });

  it("consumes the scripted results queue in order, then falls back", async () => {
    const first: HelmRenderResult = { ok: true, docs: [{ apiVersion: "v1", kind: "Namespace", name: "t-x", namespace: "", raw: {} }] };
    const second: HelmRenderResult = { ok: false, error: "helm template failed: boom" };
    const fake = new FakeHelmRenderer({ results: [first, second] });
    const base = { workdir: "/wd", chartPath: "c", valueFiles: [], releaseName: "r", namespace: "n" };

    expect(await fake.template(base)).toEqual(first);
    expect(await fake.template(base)).toEqual(second);
    // Queue exhausted → default fallback.
    expect(await fake.template(base)).toEqual({ ok: true, docs: [] });
  });

  it("honours a scripted fallback once the queue is exhausted", async () => {
    const fallback: HelmRenderResult = { ok: false, error: "scripted default" };
    const fake = new FakeHelmRenderer({ fallback });
    const base = { workdir: "/wd", chartPath: "c", valueFiles: [], releaseName: "r", namespace: "n" };
    expect(await fake.template(base)).toEqual(fallback);
  });

  it("setDocs scripts every render to the same docs and clears the queue", async () => {
    const fake = new FakeHelmRenderer({ results: [{ ok: false, error: "stale" }] });
    fake.setDocs([{ apiVersion: "v1", kind: "Service", name: "svc", namespace: "t-x", raw: {} }]);
    const base = { workdir: "/wd", chartPath: "c", valueFiles: [], releaseName: "r", namespace: "n" };

    const r1 = await fake.template(base);
    const r2 = await fake.template(base);
    expect(r1).toEqual({ ok: true, docs: [{ apiVersion: "v1", kind: "Service", name: "svc", namespace: "t-x", raw: {} }] });
    expect(r2).toEqual(r1);
  });
});
