// The MOVE-only steps of the relocation carrier: repoint the registration, wait for the
// target, and — after completeness, DNS and reopening — clear the source LAST. Everything else a
// move runs is the shared backup half (relocation.ts) and the shared target half
// (relocation-restore.ts): a move is a backup, a restore into the target, and a repoint — one
// carrier, never a third code path.
import type { Step } from "#core/server/executor/types.ts";
import { requireDbtoolsImage, runRelocationJob, type RelocationPorts, type WorldOf } from "./relocation.ts";
import { targetOf } from "./relocation-restore.ts";

/** Flip the registration's cluster field onto the target — for a tenant, with the relocating
 *  annotation set on the source CR first and the explicit source-CR delete after, so the operator
 *  RELEASES the tenant instead of deprovisioning it. */
export function repointStep(worldOf: WorldOf, targetClusterId: string): Step {
  return {
    name: "repoint",
    title: "Repoint the registration onto the target cluster",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      await w.repoint(ctx, targetOf(ctx, targetClusterId));
    },
  };
}

/** Clear the SOURCE — the last mutation of a move, strictly after completeness, DNS and reopening:
 *  drop the source databases, remove the source-side isolation objects and namespaces. The generation
 *  the move took stays on the box, as the backup of the moment before it. */
export function clearSourceStep(ports: RelocationPorts, worldOf: WorldOf): Step {
  return {
    name: "clear-source",
    title: "Clear the source (drop its data, remove its objects)",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      const jobs = await w.clearSourceJobs(ctx);
      if (jobs.length > 0) requireDbtoolsImage(ports, "clear-source");
      for (const job of jobs) await runRelocationJob(ports, ctx, w.sourceClusterId, job);
      await w.clearSourceCluster(ctx);
      ctx.checkpoint({ jobs: jobs.map((j) => j.spec.name), cleared: true });
      ctx.log("meta", `source cleared for ${w.unit} — its databases are dropped and its cluster objects removed; the unit serves from the target alone, and the generation this move took stays on the storage box. Anything the steps above reported as KEPT on the source is handarbeit and is named there`);
    },
  };
}
