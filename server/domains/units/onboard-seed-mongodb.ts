// The onboard `seed-mongodb-instance` step. Split out of onboard.run.ts (like onboard-seed-postgres.ts
// / onboard-seed-repo-pat.ts / onboard-webhook.ts) so the run file stays a thin orchestrator and the
// one per-consumer MongoDB credential write is a small, self-contained unit.
import type { Step } from "../../executor/types.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import type { OnboardPorts, DeployableOnboardParams } from "./onboard.run.ts";
import { mintMongodbRootPassword, mintMongodbKeyfile } from "./secret-mint.ts";

/** The onboard `seed-mongodb-instance` step. MANIFEST-DRIVEN through one word: the consumer's
 *  `mongodb` says whether it runs on the CLUSTER's shared replica set — which every tenant uses and
 *  which needs nothing seeded here — or on an instance of its OWN, which needs a root password and a
 *  replica-set keyfile before its first pod starts. A consumer on `shared` skips, so its seeding is
 *  byte-identical to before this step existed.
 *
 *  The write goes to its own leaf, secret/<stage>/consumer/<name>/mongodb, and not into the ceremony
 *  `app` entry, for the reason the postgres leaf exists: `app` is cas=0 create-only, so a consumer
 *  that asks for its own database on a LATER re-pin would never get the value there.
 *
 *  BOTH properties are written in ONE create-only write. A standalone mounts no keyfile — it runs
 *  without --replSet and has no intra-set traffic to authenticate — but the leaf cannot be extended
 *  later (cas=0 refuses the second write), so a unit re-onboarded from `standalone` to `replicaset`
 *  would otherwise come up with no keyfile and refuse to start.
 *
 *  Create-only also means a re-onboard onto a data volume that survived re-uses the SAME root
 *  password (created:false) instead of rotating it out from under a database that was initialised
 *  with it — the mongo image creates the root user once, at first init, and never again, so a
 *  rotation locks the platform out of a live database. Register NO abort cleanup that deletes this
 *  leaf: the volume outlives the abort. It is removed only at offboard/purge. The seeder is
 *  write-only, so the minted values are irrecoverable by design. */
export function seedMongodbInstanceStep(ports: OnboardPorts, p: DeployableOnboardParams): Step {
  return {
    name: "seed-mongodb-instance",
    title: "Seed the per-consumer MongoDB instance credential into Vault",
    run: async (ctx) => {
      if (p.mongodb === "shared") {
        ctx.log("meta", "consumer runs on the cluster's shared MongoDB replica set — no instance credential to seed");
        return;
      }
      const { created } = await ports.seeder.seedMongodb({
        stage: p.stage,
        consumerName: p.consumerName,
        rootPassword: mintMongodbRootPassword(),
        keyfile: mintMongodbKeyfile(),
      });
      const path = `${KV_MOUNT}/${p.stage}/consumer/${p.consumerName}/mongodb`;
      ctx.log(
        "meta",
        created
          ? `seeded the MongoDB instance credential write-only into ${path} (create-only) — the root password its "${p.mongodb}" instance is initialised with, plus the replica-set keyfile`
          : `MongoDB instance credential already present at ${path} — left untouched (create-only). A re-onboard re-uses the root password its data volume was initialised with; it is never rotated here.`,
      );
    },
  };
}
