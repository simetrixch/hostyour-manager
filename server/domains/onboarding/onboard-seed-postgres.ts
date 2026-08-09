// The onboard `seed-postgres-superuser` step. Split out of onboard.run.ts (like onboard-seed-repo-pat.ts
// / onboard-webhook.ts / onboard-activate.ts) so the run file stays a thin orchestrator and the one
// per-consumer PostgreSQL superuser write is a small, self-contained unit.
import type { Step } from "../../executor/types.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import { mintPostgresSuperuserPassword } from "./secret-mint.ts";

/** The onboard `seed-postgres-superuser` step. SERVICE-DRIVEN, not
 *  manifest-declared: the per-consumer PostgreSQL instance-superuser password is never in the
 *  consumer's secrets[], so it is neither a mint kind nor part of seed-secrets — it is written iff the
 *  pointer's `services` claims postgresql. A consumer that claims none (every consumer today) skips
 *  here, so its seeding is byte-identical to before this step existed.
 *
 *  The write goes to a SEPARATE leaf from the ceremony `app` entry —
 *  secret/<stage>/consumer/<name>/postgres, property postgres-password — because `app` is cas=0
 *  create-only, so a consumer that adds services:[postgresql] on a LATER re-pin would never get it
 *  there. The leaf is create-only too: a re-onboard onto a PGDATA that survived (its PVC is
 *  Prune=false) re-uses the SAME password (created:false) instead of rotating the superuser out from
 *  under a booted instance. Register NO abort cleanup that deletes it — the leaf is removed ONLY at
 *  offboard/purge. The seeder is write-only, so the minted value is irrecoverable by design;
 *  the postgres image (initdb) + ESO are its only readers. */
export function seedPostgresSuperuserStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "seed-postgres-superuser",
    title: "Seed the per-consumer PostgreSQL superuser password into Vault",
    run: async (ctx) => {
      if (!p.services.includes("postgresql")) {
        ctx.log("meta", "consumer does not claim the postgresql service — no instance-superuser to seed");
        return;
      }
      const { created } = await ports.seeder.seedPostgres({
        stage: p.stage,
        consumerName: p.consumerName,
        password: mintPostgresSuperuserPassword(),
      });
      const path = `${KV_MOUNT}/${p.stage}/consumer/${p.consumerName}/postgres`;
      ctx.log(
        "meta",
        created
          ? `seeded the PostgreSQL instance-superuser password write-only into ${path} (create-only)`
          : `PostgreSQL superuser already present at ${path} — left untouched (create-only). A re-onboard re-uses the password its PGDATA was initialised with; it is never rotated here.`,
      );
    },
  };
}
