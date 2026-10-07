// Seeds what an offboard removed: instance credentials and ceremony secrets on restore.
import type { Stage } from "../../../shared/enums.ts";
import { isOperatorSecret } from "../../../shared/consumer.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import { consumerSecretEntry, listSecretWrites } from "../../db/secret-writes.ts";
import { errValidation } from "../../kernel/errors.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { refuseMissingStoreSecrets } from "#unit/server/store-secrets.ts";
import { seedConsumerSecrets, type ConsumerSecretsSeedPorts } from "./consumer-secrets-seed.ts";
import { readDeclaredSecrets, type ManifestReadPorts } from "./set-secrets.run.ts";
import { seedPostgresInstance } from "./onboard-seed-postgres.ts";
import { seedMongodbInstance } from "./onboard-seed-mongodb.ts";
import { seedRedisInstance } from "./onboard-seed-redis.ts";
import { seedMariadbInstance } from "./onboard-seed-mariadb.ts";

export type RestoreSecretsPorts = ConsumerSecretsSeedPorts & ManifestReadPorts;

/** What the restore's plan must ask: nothing where the consumer's entry stands, else its typed keys. */
export async function planRestoreSecrets(
  ports: RestoreSecretsPorts,
  db: Db,
  unit: { stage: Stage; consumerName: string; repoURL: string },
  signal?: AbortSignal,
): Promise<{ requiredSecrets: string[]; warnings: string[] }> {
  const stands = listSecretWrites(db, consumerSecretEntry(unit.stage, unit.consumerName)).length > 0;
  if (stands) {
    return { requiredSecrets: [], warnings: [] };
  }
  const read = await readDeclaredSecrets(ports, (org) => readOwnerIdentity(db, org), unit.repoURL, signal);
  if (read.outcome === "refused") {
    throw errValidation(read.why);
  }
  if (read.secrets.length === 0) {
    return { requiredSecrets: [], warnings: [] };
  }
  const storeRefused = await refuseMissingStoreSecrets(ports.installationStore, read.secrets);
  if (storeRefused) {
    throw errValidation(storeRefused);
  }
  const requiredSecrets = read.secrets.filter((s) => isOperatorSecret(s) && s.required).map((s) => `consumer-secret:${s.key}`);
  const path = `${KV_MOUNT}/${unit.stage}/consumer/${unit.consumerName}/app`;
  const warnings = [
    `the Manager holds no record of ${path} (an offboard removes it) — this restore seeds it where Vault holds none, create-only: ${requiredSecrets.length} typed by you, the rest minted or copied from the installation's store; if Vault holds the entry without a record here, your typed values are discarded and the standing entry stays`,
  ];
  return { requiredSecrets, warnings };
}

/** Seeds what an offboard took: the instance credentials the registration needs, then the ceremony entry. */
export async function seedRestoredSecrets(
  ports: RestoreSecretsPorts,
  ctx: StepCtx,
  unit: { stage: Stage; consumerName: string; repoURL: string; services: readonly string[]; mongodb?: string | undefined; redis?: string | undefined },
  repoCredentialId: string | undefined,
): Promise<void> {
  await seedPostgresInstance(ports.seeder, ctx, unit);
  await seedMongodbInstance(ports.seeder, ctx, unit);
  await seedRedisInstance(ports.seeder, ctx, unit);
  await seedMariadbInstance(ports.seeder, ctx, unit);

  const path = `${KV_MOUNT}/${unit.stage}/consumer/${unit.consumerName}/app`;
  const stands = listSecretWrites(ctx.db, consumerSecretEntry(unit.stage, unit.consumerName)).length > 0;
  if (stands) {
    ctx.log("meta", `${path} stands — its secrets come back as they are, nothing seeded`);
    return;
  }

  const read = await readDeclaredSecrets(ports, (org) => readOwnerIdentity(ctx.db, org), unit.repoURL, ctx.signal);
  if (read.outcome === "refused") {
    throw errValidation(read.why);
  }

  await seedConsumerSecrets(ports, ctx, {
    stage: unit.stage,
    consumerName: unit.consumerName,
    secretSpecs: read.secrets,
    repoCredentialId,
    dkimKey: read.dkimKey,
  });
}
