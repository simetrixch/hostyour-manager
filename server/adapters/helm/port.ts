// The Manager's HelmRenderer port — the tenant validation engine.
// Unlike the consumer path, which renders UNTRUSTED charts inside the credential-free
// gate-runner sandbox, the tenant fan-out charts are trusted first-party charts living in
// catalog, so the Manager renders them itself: the concrete adapter (helm.ts) shells
// `helm template` over a cloned catalog workdir, flattens List/aggregates the same way the
// sandbox does (gate-runner/src/render-docs.ts parseRenderedDocs), and hands back the rendered docs
// for the tenant gates (gateT2Render/gateT3Isolation) to inspect. The fake
// (testing/fake.ts) scripts docs/errors for the domain tests.
//
// Boundary: the concrete impl owns the node:child_process IO (an adapter may import IO libs); the
// domain (validate-tenant.ts) depends only on this port. The impl needs the helm binary plus the
// charts' vendored subchart deps present in the Manager pod.

/** One flattened document out of `helm template` — every List/aggregate member emitted on its own,
 *  so nothing can hide inside a wrapper past gateT3Isolation. `raw` is the parsed object; a gate
 *  reads arbitrary fields (kind, metadata.namespace) off it. Mirrors the gate-runner RenderedDoc
 *  minus its sandbox-only env/docIndex tags. */
export interface RenderedDoc {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
  raw: Record<string, unknown>;
}

/** One `helm template` invocation. `valueFiles` are CHART-relative values files layered in order
 *  (later wins) — the ArgoCD Helm-source semantics (valueFiles resolve against the source `path`),
 *  matching what resolveFanout emits ("values.yaml", "values-<stage>.yaml"); the ADAPTER joins each
 *  onto chartPath (helmTemplateArgs), since the process cwd is the repo-root workdir, not the chart
 *  dir. `valuesObject`, when present, is staged by the adapter to a temp values file and layered
 *  LAST as the highest-precedence override (helm has no inline-object flag that round-trips nested
 *  values cleanly). Paths travel as an argv array — never a shell string. */
export interface HelmRenderRequest {
  workdir: string; // the cloned catalog checkout the chart lives in (execFile cwd)
  chartPath: string; // chart dir, workdir-relative (e.g. "charts/example-auth")
  valueFiles: string[]; // -f layers, in precedence order (CHART-relative; the adapter joins onto chartPath)
  valuesObject?: Record<string, unknown>; // an extra highest-precedence override layer
  releaseName: string; // the helm release NAME arg
  namespace: string; // --namespace
  signal?: AbortSignal; // cancels an in-flight render (DELETE / budget abort) instead of waiting out the timeout
}

/** A render outcome. A broken chart is DATA, not an exception: a helm failure returns
 *  {ok:false, error} carrying helm's stderr (gateT2Render surfaces it as its `found`), never a
 *  throw — so the caller composes one gate result per member without try/catch scaffolding. */
export type HelmRenderResult = { ok: true; docs: RenderedDoc[] } | { ok: false; error: string };

export interface HelmRenderer {
  /** Render `chartPath` at the given values into flattened RenderedDocs. Total by construction —
   *  a render/helm failure is returned as {ok:false, error}, not thrown. */
  template(req: HelmRenderRequest): Promise<HelmRenderResult>;
}
