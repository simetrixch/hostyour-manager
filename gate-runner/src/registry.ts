// gate-runner/src/registry.ts
// The sandbox CHECK gates, partitioned by what they inspect so the pipeline can run them in report
// order: G1 (structure) and G3 (render) are pipeline PHASES that produce the context; G2
// (determinism) runs over ctx.files BEFORE the render; G6/G7/G8/G22 run over ctx.rendered AFTER it.
import type { CheckGate } from "./gates/gate.ts";
import { g2 } from "./gates/g2.ts";
import { g6 } from "./gates/g6.ts";
import { g7 } from "./gates/g7.ts";
import { g8 } from "./gates/g8.ts";
import { g22 } from "./gates/g22.ts";

/** Run over ctx.files, before the render phase. */
export const PRE_RENDER_GATES: readonly CheckGate[] = [g2];

/** Run over ctx.rendered, after the render phase. */
export const POST_RENDER_GATES: readonly CheckGate[] = [g6, g7, g8, g22];
