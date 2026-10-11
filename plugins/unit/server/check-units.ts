// THE SCHEDULED CHECK RUNS EVERY STANDING UNIT'S PROBES (hostyour-manager#210): the same functions
// the onboarding ran before its approve, run again on a schedule over every standing unit, their
// findings recorded on the unit's own row and read off it by the unit's page. Drift — a record that
// moved, a token that expired, a hook that was deleted — is a finding here, before the next
// release meets it.
//
// A SLOT: each family registers the probes of its own units, and the step walks every registration
// when it runs, so a family wired after the run that carries the step is walked all the same. The
// step reads only and writes the local rows; a unit whose probe throws is recorded with that as its
// finding and the walk goes on.
import type { Step, StepCtx } from "#core/server/executor/types.ts";
import type { ProbeCtx } from "#core/server/executor/probe.ts";
import type { PreflightCheck } from "#core/shared/preflight.ts";

/** One family's probes of its standing units. */
export interface UnitProbes {
  /** One unit of the family, as the run log counts it ("consumer" is logged "N consumer(s)"). */
  readonly noun: string;
  /** Probes every standing unit of the family and records the findings on the unit's own row;
   *  answers how many units were probed and how many findings are worth a look. */
  probeAll(ctx: StepCtx, now: Date): Promise<{ probed: number; attention: number }>;
}

/** The probe context of one unit: the step's own, its log lines prefixed with the unit. */
export function unitProbeCtx(ctx: StepCtx, prefix: string): ProbeCtx {
  return { db: ctx.db, creds: ctx.creds, params: ctx.params, signal: ctx.signal, log: (l) => ctx.log("meta", `${prefix}: ${l}`) };
}

/** The one finding a probe that threw leaves under its own name. */
export const failedProbe = (id: string, title: string, err: unknown): PreflightCheck =>
  ({ id, title, severity: "hard", status: "fail", detail: `the probe could not measure: ${err instanceof Error ? err.message : String(err)}` });

/** Every registered family's units probed, in the order the families registered. */
export function checkUnitsStep(registered: () => readonly UnitProbes[]): Step {
  return {
    name: "check-units",
    title: "Run every standing unit's probes and record what they found",
    run: async (ctx) => {
      const now = new Date();
      const tally: Record<string, number> = {};
      const counted: string[] = [];
      let attention = 0;
      for (const probes of registered()) {
        if (ctx.signal.aborted) break;
        const done = await probes.probeAll(ctx, now);
        tally[`${probes.noun}s`] = done.probed;
        counted.push(`${done.probed} ${probes.noun}(s)`);
        attention += done.attention;
      }
      ctx.checkpoint({ ...tally, attention });
      ctx.log("meta", `${counted.join(" and ")} probed: ${attention} finding(s) worth a look, recorded on their rows`);
    },
  };
}
