// WHAT AN APPROVE IS HELD TO before the run is started (Executor.approve): every required secret
// carries a value, and whatever the definition can measure on the handed-in values holds
// (hostyour-manager#212). Refused here, the run stays planned and the person corrects the value;
// refused inside the run, it is a failed run with a row to take back.
import type { Db } from "../db/client.ts";
import { errValidation } from "../kernel/errors.ts";
import type { AnyRunDefinition, PlanSnapshot } from "./types.ts";

export async function assertApprovable(
  run: { kind: string; params: Record<string, unknown>; plan: PlanSnapshot },
  def: AnyRunDefinition | undefined,
  db: Db,
  secrets: Record<string, Buffer> | undefined,
): Promise<void> {
  for (const name of run.plan.requiredSecrets) {
    // A 0-length Buffer is truthy — reject it too, or an empty operator value would pass here and
    // (for onboard) be seeded create-only into Vault as a PERMANENT empty secret (cas=0, no rotate).
    if (!secrets?.[name] || secrets[name].length === 0) throw errValidation(`missing required secret: ${name}`);
  }
  // What only the handed-in values can answer — a build unit PAT's scopes — measured by the
  // definition before anything moves.
  if (def?.assertApprovable) await def.assertApprovable(def.paramsSchema.parse(run.params), { db, secrets: secrets ?? {} });
}
