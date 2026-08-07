// gate-runner/src/gates/gate.ts
// The contract every sandbox gate implements. G1, G2, G3, G6, G7, G8 and G22
// run INSIDE the runner over untrusted content; G16/G17/G18 are Controller-side (domains/onboarding/
// gates/compose.ts) and are NOT here. The pipeline (../pipeline.ts) does ALL the IO — unpack + verify the
// bundle tree, parse the manifest (G1), `helm dependency build` + `helm template` per env
// (G3) — and hands each CHECK gate a fully assembled, read-only GateContext. Check gates are
// therefore PURE and synchronous: they unit-test against hand-built contexts, and the poisoned
// fixtures drive them through the real pipeline.
import type { GateResult, GateSeverity, ResolvedDependency } from "../../../shared/gates.ts";
import type { ClusterValueFile } from "../../../shared/cluster-values.ts";
import type { ConsumerManifest } from "../../../shared/consumer.ts";

/** One document out of `helm template`, parsed and tagged with the env it rendered for and its
 *  position in the stream, so a gate can cite evidence ({source:"rendered", docIndex, kind,
 *  name, fieldPath}). `raw` is the parsed object — gates read arbitrary fields (Service.spec.type,
 *  PVC annotations, pod securityContext) off it. */
export interface RenderedDoc {
  env: string;
  docIndex: number;
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
  raw: Record<string, unknown>;
}

/** Everything a sandbox check gate may inspect — assembled once per job (bundle mode).
 *  Read-only: a gate never mutates it. `manifest` is null when G1 could not parse/validate the
 *  manifest (the later hard gates then fail fast with that as their found/reason). `rendered` and
 *  `dependencies` stay empty until G3 fills them (and remain empty if the render itself failed). */
export interface GateContext {
  readonly targetName: string;
  readonly stage: string;
  readonly chartPath: string;
  /** The target cluster's values chain, VERBATIM and in layering order — the same bytes G3 rendered
   *  with, so a gate that needs a cluster value (G7's Vault server) reads it from the chain rather
   *  than from a value the Controller pre-computed. */
  readonly clusterValueFiles: readonly ClusterValueFile[];
  /** repo-relative path (forward slashes) -> UTF-8 contents, for the static gates (G2 over
   *  templates/**, image-reference scans). Binary files are omitted. */
  readonly files: ReadonlyMap<string, string>;
  readonly manifest: ConsumerManifest | null;
  readonly rendered: readonly RenderedDoc[];
  readonly dependencies: readonly ResolvedDependency[];
}

/** A pure sandbox check gate: G2, G6, G7, G8, G22. G1 (structure/manifest parse) and G3
 *  (render + pinned deps) are pipeline PHASES that additionally produce parts of the context, so
 *  they live in the pipeline, not behind this interface. Each check authors its own expected/found/reason
 *  expected/found/reason via ./result.ts, so the text and the predicate cannot drift. */
export interface CheckGate {
  readonly id: string; // "G2" | "G6" | "G7" | "G8" | "G22"
  readonly title: string;
  readonly severity: GateSeverity;
  check(ctx: GateContext): GateResult;
}
