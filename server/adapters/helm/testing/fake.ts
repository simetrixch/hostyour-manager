// A scripted HelmRenderer for the tenant domain tests — no helm binary, no child process. Hand it
// the results to return (a queue consumed one per template() call in render order, or a single
// default) and assert what validate-tenant does with them; it records every request so a test can
// assert the exact chart / values / release / namespace each fan-out member was rendered with.
// Requests are recorded VERBATIM: valueFiles stay the CHART-relative names of the port contract —
// joining them onto chartPath is the REAL adapter's argv concern (helm.ts helmTemplateArgs), not
// part of the request shape, so domain tests keep asserting the chart-relative layering.
import type { HelmRenderer, HelmRenderRequest, HelmRenderResult, RenderedDoc } from "../port.ts";

export interface FakeHelmScript {
  /** Consumed one per template() call, in order; when exhausted, `fallback` is used. */
  results?: HelmRenderResult[];
  /** Returned once `results` is exhausted (defaults to {ok:true, docs:[]}). */
  fallback?: HelmRenderResult;
}

export class FakeHelmRenderer implements HelmRenderer {
  readonly requests: HelmRenderRequest[] = [];
  private queue: HelmRenderResult[];
  private fallback: HelmRenderResult;

  constructor(script: FakeHelmScript = {}) {
    this.queue = [...(script.results ?? [])];
    this.fallback = script.fallback ?? { ok: true, docs: [] };
  }

  /** Replace the scripted queue + fallback between calls (e.g. plan's render vs. the revalidate). */
  setScript(script: FakeHelmScript): void {
    this.queue = [...(script.results ?? [])];
    this.fallback = script.fallback ?? { ok: true, docs: [] };
  }

  /** Convenience: script every render (queue cleared) to return exactly `docs`. */
  setDocs(docs: RenderedDoc[]): void {
    this.queue = [];
    this.fallback = { ok: true, docs };
  }

  async template(req: HelmRenderRequest): Promise<HelmRenderResult> {
    this.requests.push(req);
    const next = this.queue.shift();
    return next ?? this.fallback;
  }
}
