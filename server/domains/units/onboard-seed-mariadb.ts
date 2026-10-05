// The onboard `seed-mariadb-instance` step, beside onboard-seed-postgres.ts: the one per-consumer
// MariaDB credential write, as a small unit of its own.
import type { Step } from "../../executor/types.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import { mintMariadbRootPassword } from "#unit/server/secret-mint.ts";

/** The onboard `seed-mariadb-instance` step. A consumer that claims `mariadb` runs a MariaDB of its own,
 *  which needs the root password its first start initialises the database with. The write goes to its
 *  own leaf, secret/<stage>/consumer/<name>/mariadb, create-only, for the reasons seed-mongodb-instance
 *  states: a re-onboard onto a surviving volume keeps the password the data was initialised with, no
 *  abort cleanup deletes it, and offboard and purge remove it. */
export function seedMariadbInstanceStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "seed-mariadb-instance",
    title: "Seed the per-consumer MariaDB root password into Vault",
    run: async (ctx) => {
      if (!p.services.includes("mariadb")) {
        ctx.log("meta", "consumer claims no mariadb — no MariaDB of its own to seed a password for");
        return;
      }
      const { created } = await ports.seeder.seedMariadb({ stage: p.stage, consumerName: p.consumerName, password: mintMariadbRootPassword() });
      const path = `${KV_MOUNT}/${p.stage}/consumer/${p.consumerName}/mariadb`;
      ctx.log(
        "meta",
        created
          ? `seeded the MariaDB root password write-only into ${path} (create-only)`
          : `MariaDB root password already present at ${path} — left untouched (create-only). A re-onboard re-uses the password its data volume was initialised with; it is never rotated here.`,
      );
    },
  };
}
