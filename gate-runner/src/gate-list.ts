// gate-runner/src/gate-list.ts
// The sandbox CHECK gates, partitioned by what they inspect so the pipeline can run them in report
// order: structure (G1) and render-pinned-deps (G3) are pipeline PHASES that produce the context;
// determinism (G2) runs over ctx.files BEFORE the render; data-protection (G6), secret-contract (G7),
// image-discipline (G8) and database-sync-ordering (G22) run over ctx.rendered AFTER it.
import type { CheckGate } from "./gates/gate.ts";
import { determinismGate } from "./gates/determinism.gate.ts";
import { dataProtectionGate } from "./gates/data-protection.gate.ts";
import { secretContractGate } from "./gates/secret-contract.gate.ts";
import { imageDisciplineGate } from "./gates/image-discipline.gate.ts";
import { databaseSyncOrderingGate } from "./gates/database-sync-ordering.gate.ts";
import { STRUCTURE_GATE_ID } from "./gates/structure.gate.ts";
import { RENDER_GATE_ID } from "./gates/render-pinned-deps.gate.ts";

/** Run over ctx.files, before the render phase. */
export const PRE_RENDER_GATES: readonly CheckGate[] = [determinismGate];

/** Run over ctx.rendered, after the render phase. */
export const POST_RENDER_GATES: readonly CheckGate[] = [dataProtectionGate, secretContractGate, imageDisciplineGate, databaseSyncOrderingGate];

/** Every gate the sandbox runs, in report order — the two pipeline phases and the check gates
 *  between and after them. A run that never started names these as the checks that did not inspect
 *  the repository, so the list is DERIVED from the modules that own the ids: a gate added to either
 *  array above is named by that refusal without anybody remembering to add it here. */
export const SANDBOX_GATE_IDS: readonly string[] = [
  STRUCTURE_GATE_ID,
  ...PRE_RENDER_GATES.map((g) => g.id),
  RENDER_GATE_ID,
  ...POST_RENDER_GATES.map((g) => g.id),
];
