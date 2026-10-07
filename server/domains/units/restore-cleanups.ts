// Compensations for an aborted consumer restore: undoes what the restore provisioned.
import { eq } from "drizzle-orm";
import type { Cleanup, StepCtx } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { apps } from "../../db/schema/inventory.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { consumerArgoAppName, consumerNamespace } from "../../../shared/consumer.ts";
import type { Stage } from "../../../shared/enums.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import { consumerRepoCredentialName } from "./repo-credential.ts";
import { gone } from "./offboard.run.ts";
import { removeCeremonySecretsCleanup } from "./consumer-secrets-seed.ts";
import type { ConsumerRelocationPorts } from "./relocation-world-consumer.ts";

/** Reads the app row and ensures the unit was offboarded; returns null and logs when not. */
export function offboardedApp(db: Db, appId: string, ctx: StepCtx): { name: string; stage: Stage } | null {
  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  if (!app) throw errNotFound(`app ${appId}`);
  if (app.status !== "offboarded") {
    ctx.log("meta", `${app.name} (${app.stage}) was not offboarded when this restore started — nothing of it is removed`);
    return null;
  }
  return { name: app.name, stage: app.stage };
}

/** The compensations of a consumer restore. They are armed together by one step, so an abort runs
 *  them in this order: the executor reverses steps, not a step's own compensations. */
export function restoreCleanups(ports: ConsumerRelocationPorts, params: { appId: string; targetClusterId: string }): Cleanup[] {
  return [
    {
      name: "restore-remove-repo-credential",
      title: "Delete the ArgoCD repository credential the restore wrote on the target",
      run: async (ctx) => {
        const app = offboardedApp(ctx.db, params.appId, ctx);
        if (!app) return;
        if (!ports.repoCredential) {
          throw errValidation(`compensation for "${app.name}" requires the repository-credential writer, but none was wired`);
        }
        const { argoNamespace } = await ports.resolver.resolve(params.targetClusterId);
        const credName = consumerRepoCredentialName(app.name, app.stage);
        const { deleted } = await ports.repoCredential.deleteRepoCredential(argoNamespace, credName);
        ctx.log(
          "meta",
          deleted
            ? `ArgoCD repository credential for ${app.name} at ${app.stage} deleted on the target`
            : `no ArgoCD repository credential for ${app.name} at ${app.stage} on the target — already absent`,
        );
      },
    },
    {
      name: "restore-remove-instance-secrets",
      title: "Destroy the database instance credentials the restore seeded (Vault consumer tier)",
      run: async (ctx) => {
        const app = offboardedApp(ctx.db, params.appId, ctx);
        if (!app) return;
        await ports.seeder.deletePostgres({ stage: app.stage, consumerName: app.name });
        await ports.seeder.deleteMongodb({ stage: app.stage, consumerName: app.name });
        await ports.seeder.deleteRedis({ stage: app.stage, consumerName: app.name });
        await ports.seeder.deleteMariadb({ stage: app.stage, consumerName: app.name });
        ctx.log("meta", `database instance credentials removed — ${KV_MOUNT}/${app.stage}/consumer/${app.name}/{postgres,mongodb,redis,mariadb} deleted (all versions)`);
      },
    },
    {
      name: "restore-remove-target",
      title: "Take back the registration, the Application and the namespace the restore made on the target",
      run: async (ctx) => {
        const app = offboardedApp(ctx.db, params.appId, ctx);
        if (!app) return;
        const standing = await ports.registrations.readRegistration(app.stage, app.name);
        if (standing !== null) {
          if (!standing.entry.removing) {
            const { commit } = await ports.registrations.setRemoving(app.stage, app.name, ctx.runId);
            ctx.log(
              "meta",
              `registration for ${app.name} (${app.stage}) marked removing (${commit}) — the Application is pruned while its AppProject still stands`,
            );
          } else {
            ctx.log("meta", `registration for ${app.name} at ${app.stage} already marked removing — skipping`);
          }
        } else {
          ctx.log("meta", `registration for ${app.name} at ${app.stage} already absent — skipping`);
        }
        const { argoReader, argoNamespace, clusterReader } = await ports.resolver.resolve(params.targetClusterId);
        const appName = consumerArgoAppName(app.name, app.stage);
        const status = await argoReader.watchApplication(argoNamespace, appName, gone, {
          signal: ctx.signal,
          timeoutMs: ports.argoWatchTimeoutMs,
          failFast: (s) => s.deletionError !== undefined,
        });
        if (!gone(status)) {
          throw errNotFound(
            `Application ${appName} was not pruned — ${status.deletionError ? `ArgoCD reports: ${status.deletionError}` : `last seen health=${status.health}${status.message ? ` (${status.message})` : ""}`}; the registration was removed but the workloads linger on the target`,
          );
        }
        ctx.log("meta", `Application ${appName} pruned on target`);
        if ((await ports.registrations.readRegistration(app.stage, app.name)) !== null) {
          const { commit, unitRemoved } = await ports.registrations.removeRegistration(app.stage, app.name, ctx.runId);
          ctx.log(
            "meta",
            `registration for ${app.name} (${app.stage}) removed (${commit}) — the AppProject, the admission policy and the argo-sync grant are rendered from the registration by ApplicationSets and go with it` +
              (unitRemoved ? "; it was the unit's last stage, so its build.yaml went too" : "; the unit stays registered at its other stages"),
          );
        }
        const namespace = consumerNamespace(app.name, app.stage);
        const { deleted } = await clusterReader.deleteNamespace(namespace);
        ctx.log(
          "meta",
          deleted
            ? `namespace ${namespace} deleted on the target cluster — the consumer leaves no lingering namespace`
            : `namespace ${namespace} was already absent on the target cluster — nothing to delete`,
        );
      },
    },
  ];
}

/** The ceremony secrets cleanup for consumer restore, guarded by the offboarded rule. */
export function restoreCeremonySecretsCleanup(ports: Pick<ConsumerRelocationPorts, "seeder">, params: { appId: string }): Cleanup {
  return removeCeremonySecretsCleanup(ports, (ctx) => {
    const app = offboardedApp(ctx.db, params.appId, ctx);
    return app ? { stage: app.stage, consumerName: app.name } : null;
  });
}
