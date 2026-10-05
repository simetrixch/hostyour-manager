// The onboard `seed-redis-instance` step, beside onboard-seed-mongodb.ts: the one per-consumer Redis
// credential write, as a small unit of its own.
import type { Step } from "../../executor/types.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import { mintRedisPassword } from "#unit/server/secret-mint.ts";

/** The onboard `seed-redis-instance` step. A consumer on the cluster's shared Redis needs nothing
 *  seeded; one with a Redis of its OWN needs the password its server boots with (`--requirepass`)
 *  before the first pod starts. The write goes to its own leaf, secret/<stage>/consumer/<name>/redis,
 *  create-only, for the reasons seed-mongodb-instance states: a re-onboard onto a surviving volume
 *  keeps the password, no abort cleanup deletes it, and offboard and purge remove it. */
export function seedRedisInstanceStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "seed-redis-instance",
    title: "Seed the per-consumer Redis instance password into Vault",
    run: async (ctx) => {
      if (p.redis !== "standalone") {
        ctx.log("meta", "consumer runs on the cluster's shared Redis — no instance password to seed");
        return;
      }
      const { created } = await ports.seeder.seedRedis({ stage: p.stage, consumerName: p.consumerName, password: mintRedisPassword() });
      const path = `${KV_MOUNT}/${p.stage}/consumer/${p.consumerName}/redis`;
      ctx.log(
        "meta",
        created
          ? `seeded the Redis instance password write-only into ${path} (create-only)`
          : `Redis instance password already present at ${path} — left untouched (create-only). A re-onboard re-uses the password its clients hold; it is never rotated here.`,
      );
    },
  };
}
