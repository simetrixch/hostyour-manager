// Seeds the ceremony entry for a consumer into Vault create-only.
import { and, eq } from "drizzle-orm";
import type { Stage } from "../../../shared/enums.ts";
import type { ConsumerSecretSpec } from "../../../shared/consumer.ts";
import type { Cleanup, StepCtx } from "../../executor/types.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import { apps } from "../../db/schema/inventory.ts";
import { consumerSecretEntry, forgetSecretEntry, recordSecretWrites } from "../../db/secret-writes.ts";
import { errValidation } from "../../kernel/errors.ts";
import { buildConsumerSecretDataWithDerivations } from "#unit/server/secret-mint.ts";
import { readStoreSecrets } from "#unit/server/store-secrets.ts";
import { dropUnitCallKey, findUnitCallKey, keepUnitCallKey } from "#unit/server/unit-call-key.ts";
import type { DeployableOnboardParams, OnboardPorts } from "./onboard.run.ts";

export interface ConsumerSecretsSeedInput {
  stage: Stage;
  consumerName: string;
  secretSpecs: readonly ConsumerSecretSpec[];
  /** The repository credential a key derived from the repository PAT is read through. */
  repoCredentialId: string | undefined;
  activation?: DeployableOnboardParams["activation"] | undefined;
  /** The manifest's DKIM key, whose public half the Mail page publishes from the app row. */
  dkimKey?: string | undefined;
}

export type ConsumerSecretsSeedPorts = Pick<OnboardPorts, "seeder" | "installationStore">;

/** The abort inverse of seed-secrets: destroy the ceremony entry THIS run created (metadata-delete,
 *  all versions), so the next onboard of the name reaches created:true instead of inheriting this
 *  run's JWT signing keys and bootstrap token under the cas=0 create-only seed — the exact
 *  silent-inheritance defect offboard's remove-app-secrets kills, closed on the abort path too.
 *
 *  Registered by seed-secrets ONLY on created:true, never up front like its siblings: the seed's cas=0
 *  outcome IS the existence probe, and created:false means the entry belongs to an EARLIER onboard of
 *  this name — a compensation may undo only what this run created, and destroying a live consumer's
 *  standing entry on a re-onboard's abort would strip the very secrets its pods boot from. */
export function removeCeremonySecretsCleanup(ports: Pick<OnboardPorts, "seeder">, p: { stage: Stage; consumerName: string }): Cleanup {
  return {
    name: "remove-ceremony-secrets",
    title: "Destroy the ceremony secrets this run minted (Vault consumer tier)",
    run: async (ctx) => {
      await ports.seeder.deleteApp({ stage: p.stage, consumerName: p.consumerName });
      forgetSecretEntry(ctx.db, consumerSecretEntry(p.stage, p.consumerName));
      if (await dropUnitCallKey(ctx.creds, p.consumerName, p.stage) > 0) ctx.log("meta", `the key ${p.consumerName} (${p.stage}) accepts from the Manager is no longer kept`);
      ctx.log("meta", `ceremony secrets removed — ${KV_MOUNT}/${p.stage}/consumer/${p.consumerName}/app deleted (all versions); a later onboard of "${p.consumerName}" mints fresh secrets instead of inheriting this run's`);
    },
  };
}

/** Seeds the consumer's ceremony entry create-only; hands the onboard's activation the bootstrap token through `runtime`. */
export async function seedConsumerSecrets(
  ports: ConsumerSecretsSeedPorts,
  ctx: StepCtx,
  input: ConsumerSecretsSeedInput,
  runtime?: { bootstrapToken?: string | undefined },
): Promise<void> {
  if (input.secretSpecs.length === 0) {
    ctx.log("meta", "no secrets declared in the manifest — nothing to seed");
    return;
  }
  // A `generate` key is MINTED + verified here (the operator is never asked — requiredSecrets
  // excludes it); a required non-generate key MUST have been supplied at approve (fail closed);
  // an optional non-generate key is seeded only when supplied. All of it — including the RSA
  // keypair pairing + the complexity verification — is buildConsumerSecretData (secret-mint.ts).
  // A `store` key is copied from the installation's store, read again here because no value
  // rides the plan; the operator typed none of them.
  const fromStore = await readStoreSecrets(ports.installationStore, input.secretSpecs);
  const { data, minted, publicKeys } = await buildConsumerSecretDataWithDerivations(
    input.secretSpecs,
    (key) => fromStore.values[key] ?? ctx.secrets.get(`consumer-secret:${key}`)?.toString("utf8"),
    () => {
      if (!input.repoCredentialId) {
        throw errValidation(`consumer "${input.consumerName}" has no repository credential to read the repository a derived key needs`);
      }
      return ctx.creds.open(input.repoCredentialId, { purpose: "consumer-onboard:seed-secrets:deploy-git-credentials", runId: ctx.runId });
    },
  );
  const keys = Object.keys(data);
  if (keys.length === 0) {
    ctx.log("meta", "all declared secrets are optional and none were supplied — nothing to seed");
    return;
  }
  // ONE put carries the whole entry, and it is CREATE-ONLY (cas=0, seeder-port.ts): the mint
  // above is unconditional, so without cas=0 a re-run would silently rotate a live consumer's
  // keys out from under its running pods. An entry that already exists is left untouched and the
  // values minted for this run are discarded — this step is idempotent, as onboard claims.
  const { created } = await ports.seeder.seed({
    stage: input.stage,
    consumerName: input.consumerName,
    data,
  });
  const path = `${KV_MOUNT}/${input.stage}/consumer/${input.consumerName}/app`;
  if (!created) {
    // Say it plainly: an operator who added a key to the manifest and re-ran MUST see that
    // it did not land, rather than discover it as a missing env var at the consumer's boot.
    ctx.log("meta", `secrets already present at ${path} — left untouched (create-only). This run minted nothing new: re-running never rotates or extends an existing entry. To change it, rotate deliberately.`);
    // The value just minted was discarded, so it is never kept: a kept key the entry does not
    // hold would be presented to the unit as the Manager's and refused there.
    const standingKey = input.secretSpecs.find((s) => s.generate === "manager-key");
    if (standingKey && !(await findUnitCallKey(ctx.creds, input.consumerName, input.stage))) {
      ctx.log("meta", `the Manager keeps no ${standingKey.key} for ${input.consumerName} (${input.stage}), so it cannot call the unit — mint it anew with "Set secrets" (${standingKey.key})`);
    }
    return;
  }
  // Arm the inverse ONLY on a real create (see removeCeremonySecretsCleanup for why never up
  // front): from here the entry is this run's own, so an abort destroys it and the next onboard
  // reaches created:true again. Registered after the write by necessity — cas=0 is the existence
  // probe — so a crash between the Vault create and this line loses the armed inverse; the entry
  // then survives an abort and offboard/purge's remove-app-secrets remains its removal.
  ctx.registerCleanup(removeCeremonySecretsCleanup(ports, { stage: input.stage, consumerName: input.consumerName }));
  recordSecretWrites(ctx.db, { entry: consumerSecretEntry(input.stage, input.consumerName), keys, act: "seeded", runId: ctx.runId });
  // The key the unit accepts from the Manager alone: the entry above holds it and the Manager may
  // not read the entry back, so it keeps the same value sealed (unit-call-key.ts). Only on this
  // create: a re-run over a standing entry discarded its mint, and set-secrets mints it anew.
  const managerKey = input.secretSpecs.find((s) => s.generate === "manager-key");
  const managerKeyValue = managerKey ? data[managerKey.key] : undefined;
  if (managerKey && managerKeyValue !== undefined) {
    await keepUnitCallKey(ctx.creds, { unit: input.consumerName, stage: input.stage, key: managerKey.key, value: managerKeyValue });
    ctx.log("meta", `${managerKey.key} is kept sealed under ${input.consumerName} (${input.stage}), so the Manager can call it`);
  }
  // Keep the freshly-minted bootstrap token in-run memory for a manifest-declared activation
  // call — reachable ONLY on a real create (the create-only re-run returned above), so the
  // value in `data` IS the live token, not a re-minted one Vault refused. Never persisted/logged
  // (the manifest schema requires tokenSecret to name a declared secret, so `data` always has it here).
  if (input.activation && runtime) runtime.bootstrapToken = data[input.activation.tokenSecret];
  ctx.log("meta", `seeded ${keys.length} secret(s) write-only into ${path}` + (minted.length ? `; platform-generated + verified: ${minted.join(", ")}` : "") + (fromStore.read.length ? `; copied from the installation's store: ${fromStore.read.join(", ")}` : ""));
  // A mail sender's DKIM key: the public half stays on the unit's row for the Mail page to publish
  // — only here, on the create that put its private half into Vault, so the two always match.
  const dkimKey = input.dkimKey;
  const dkimPublicKey = dkimKey !== undefined ? publicKeys[dkimKey] : undefined;
  if (dkimPublicKey !== undefined) {
    ctx.db.update(apps).set({ dkimPublicKey, updatedAt: new Date() }).where(and(eq(apps.name, input.consumerName), eq(apps.stage, input.stage))).run();
    ctx.log("meta", `the public half of ${dkimKey} is kept on ${input.consumerName}'s row — the Mail page publishes it as the DKIM key of the platform domain`);
  }
}
