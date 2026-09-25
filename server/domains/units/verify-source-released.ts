// verify-source-released — the safety property of the whole relocation, measured LIVE between the
// repoint and the restore: the SOURCE must have RELEASED the unit (a) while still HOLDING its data
// (b). Both halves have a real failure mode, and each names a different catastrophe:
//   (a) the source handle is gone — a consumer's source Application pruned, a tenant's source CR
//       released. Still standing ⇒ TWO live copies of one unit could serve and write at once, which
//       is the failure this whole step order exists to prevent. The run stops before restore.
//   (b) the source DATA is still present — the listing job finds the unit's databases. Empty ⇒ the
//       release DESTROYED instead of releasing, and the box folder is now the only copy. The run stops
//       BEFORE restore and BEFORE clear-source, so nothing further is lost and the folder survives.
//       TWO releases can fail this way and the refusal names both, because they are different repairs:
//       the claim mark on the source namespaces (CLAIM_RELOCATING_ANNOTATION — without it the
//       service-provisioner drops a claim's databases when the repoint prunes the ServiceClaims, and
//       this is the ONLY release a consumer has), and for a tenant additionally the Tenant CR's
//       relocating annotation (without it the operator runs its whole deprovision on the source CR).
//       (b) is measured only where there IS something to measure: a unit whose stores the cascade
//       cannot destroy has no listing job (sourceDbListJob returns null) and the step ends on (a).
//       Reading "no database found" as destruction for a unit that never had one would abort every
//       move of a store-less unit AFTER the repoint, with an accusation that is false.
// There is deliberately NO Vault half: one shared KV mount serves every cluster and a move never
// touches it — a check with no failure mode measures nothing.
import type { Step } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";
import { parseDbLines } from "./relocation-jobs.ts";
import { requireDbtoolsImage, runRelocationJob, type RelocationPorts, type WorldOf } from "./relocation.ts";
import { CLAIM_RELOCATING_ANNOTATION } from "../../adapters/kube/port.ts";

export function verifySourceReleasedStep(ports: RelocationPorts, worldOf: WorldOf): Step {
  return {
    name: "verify-source-released",
    title: "Verify the source released the unit and still holds its data",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      // (a) the handle: gone, or the run refuses — two live copies must never both serve.
      await w.verifySourceHandleReleased(ctx);
      // (b) the data: a Job on the SOURCE cluster lists the unit's databases. This is the live
      // measurement that the release only let go — if the source deprovisioned instead, the
      // databases are missing and the run aborts here, before restore and before clear-source.
      requireDbtoolsImage(ports, "verify-source-released");
      const job = await w.sourceDbListJob(ctx);
      if (job === null) {
        ctx.checkpoint({ sourceDatabases: [] });
        ctx.log("meta", `${w.kindWord} ${w.unit} holds no database the ServiceClaim cascade could have dropped — the handle is released and there is nothing to list, so the data half is skipped`);
        return;
      }
      const logs = await runRelocationJob(ports, ctx, w.sourceClusterId, job);
      const dbs = parseDbLines(logs);
      if (dbs.length === 0) {
        throw errValidation(
          `the source no longer holds any database of ${w.kindWord} ${w.unit} — the release DESTROYED the source data instead of letting it go` +
            ` (the ${CLAIM_RELOCATING_ANNOTATION} mark did not make the service-provisioner keep the databases when the repoint pruned the ServiceClaims` +
            (w.kindWord === "tenant" ? `, or the relocating annotation did not make the operator skip its delete branch on the Tenant CR)` : `)`) +
            `; aborting BEFORE restore and BEFORE clear-source — the box folder /${w.unit}/ is now the only complete copy, keep it`,
        );
      }
      ctx.checkpoint({ sourceDatabases: dbs });
      ctx.log("meta", `source released ${w.unit} and still holds ${dbs.length} database(s): ${dbs.join(", ")} — clear-source is what may drop them, later`);
    },
  };
}
