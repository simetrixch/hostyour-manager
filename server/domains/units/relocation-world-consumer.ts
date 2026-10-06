// The CONSUMER shape of the relocation carrier: how ONE consumer app quiesces, dumps, provisions,
// repoints, restores, verifies and clears — everything relocation.ts's kind-neutral steps reach
// through the RelocationWorld. A consumer is one Application, one namespace, one AppProject; its
// stores are its Mongo databases[], its per-consumer PostgreSQL, its claim bucket and its PVCs.
import { eq } from "drizzle-orm";
import type { StepCtx } from "../../executor/types.ts";
import type { ArgoAppStatus, WorkloadStatus } from "../../adapters/kube/port.ts";
import { apps } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { RedisMode } from "#unit/shared/unit-size.ts";
import { consumerArgoAppName, consumerNamespace, ConsumerRegistrationSchema, type ConsumerStageRegistration } from "../../../shared/consumer.ts";
import { localTx } from "../../executor/stepkit.ts";
import { unitRepoCredentialId } from "#unit/server/repo-identity.ts";
import { readOwnerIdentity } from "#unit/server/owners.ts";
import { serializePointer, parseRegistration } from "#unit/server/registration-laws.ts";
import type { Registrations } from "#unit/server/registrations.ts";
import { loadAppCluster, type LifecyclePorts } from "./lifecycle.ts";
import { resolveMasterCluster } from "../inventory/read.ts";
import { unitApexFromChain } from "#unit/server/unit-apex.ts";
import { } from "#unit/server/build-rbac.ts";
import { consumerRepoCredentialName } from "./repo-credential.ts";
import { keepUnitRepoCredential } from "./repo-credential-keep.ts";
import { consumerUnitHost } from "#unit/server/unit-dns.ts";
import type { RepoCredentialWriter, BuildRbacWriter } from "../../adapters/kube/port.ts";
import { CLAIM_RELOCATING_ANNOTATION } from "../../adapters/kube/port.ts";
import { runRelocationJob, type RelocationPorts, type RelocationWorld, type WorldOf } from "#unit/server/relocation.ts";
import { watchConsumerSwitch } from "./consumer-switch-watch.ts";
import { servedSharedDatabases, sharedDataRefusal, type SharedDataClaim } from "./shared-data-guard.ts";
import { targetOf } from "#unit/server/relocation-restore.ts";
import {
  consumerDumpJobs, claimsIdentity, tarredClaims,
  consumerRestoreJobs, consumerGenerationClaimsJob, parseClaimLines,
  consumerVerifyCompletenessJobs,
  consumerSourceDbListJob,
  consumerClearSourceJobs,
  consumerExpectedDumpEntries,
} from "./relocation-jobs-consumer.ts";

/** The consumer relocation port set: the kind-neutral relocation ports PLUS the consumer registrations
 *  (LifecyclePorts, so the shared attest-target step composes) and the target-side provisioning
 *  writers the migrate/restore run kinds re-arm on the target. */
export interface ConsumerRelocationPorts extends RelocationPorts, LifecyclePorts {
  registrations: Registrations;
  /** clear-source's only writer: the argo-sync grant of the cluster the unit is LEAVING. Absent ⇒
   *  the grant is left to the source reconciler's own prune (offboard's shape). */
  buildRbac?: BuildRbacWriter;
  /** Needed by provision-target for a unit whose repo is private — absent then ⇒ fail loud. */
  repoCredential?: RepoCredentialWriter;
}

/** The registration's deploy group, read STRICTLY: the relocation of a consumer is meaningless
 *  without its data scope, so an absent/registration-less unit throws rather than dumping nothing. */
async function readStageRegistration(ports: ConsumerRelocationPorts, stage: Stage, name: string): Promise<ConsumerStageRegistration> {
  const read = await ports.registrations.readRegistration(stage, name);
  if (!read) throw errValidation(`consumer "${name}" is not registered at ${stage} — nothing to relocate`);
  const e = read.entry;
  if (e.chartPath === undefined || e.cluster === undefined || e.databases === undefined || e.services === undefined || e.size === undefined || e.mongodb === undefined || e.quota === undefined || e.host === undefined) {
    throw errValidation(`registrations/${name}/${stage}.yaml carries no deploy group — a stage registration must`);
  }
  return { ...e, chartPath: e.chartPath, cluster: e.cluster, databases: e.databases, services: e.services, size: e.size, mongodb: e.mongodb, quota: e.quota, host: e.host };
}

/** Whether `w` is one of the consumer's OWN stores, which stand in its namespace as further sources of
 *  its Application `appName` and read neither switch: they keep running through a quiesce, which is
 *  what keeps them reachable for the dump, and through a suspend. The per-consumer PostgreSQL's chart
 *  (hostyour-cloud clusters/units/postgresql) pins the database as `postgres` and renders a metrics
 *  exporter, which reads and writes nothing; the upstream exporter chart names it after the Helm
 *  release, which is the Application. An own MongoDB runs as the StatefulSet `mongodb`
 *  (clusters/units/mongodb), an own Redis as the Deployments `redis` and `redis-exporter`
 *  (clusters/units/redis), an own MariaDB as `mariadb` and `mariadb-exporter` (clusters/units/mariadb),
 *  each only where the registration brings one. Exact names, so an application workload never passes
 *  for a store. */
export function consumerStoreWorkload(reg: Pick<ConsumerStageRegistration, "mongodb" | "redis" | "services">, appName: string): (w: WorkloadStatus) => boolean {
  const ownMongo = reg.mongodb !== "shared";
  const ownRedis = reg.redis === "standalone";
  const ownMariadb = reg.services.includes("mariadb");
  return (w) => w.name === "postgres" || w.name === `${appName}-prometheus-postgres-exporter` || (ownMongo && w.kind === "StatefulSet" && w.name === "mongodb") ||
    (ownRedis && w.kind === "Deployment" && (w.name === "redis" || w.name === "redis-exporter")) ||
    (ownMariadb && w.kind === "Deployment" && (w.name === "mariadb" || w.name === "mariadb-exporter"));
}

/** Refuse to place `name` at `stage` on `cluster` where another registration is served a database it
 *  would be served, or holds Redis keys or channels it would reach: the two would share data. */
async function refuseSharedData(ports: ConsumerRelocationPorts, cluster: string, stage: Stage, name: string, claim: SharedDataClaim): Promise<void> {
  const refusal = await sharedDataRefusal(ports.registrations, cluster, stage, name, claim);
  if (refusal) throw errValidation(refusal);
}

/** Refuse a move of `name` at `stage` onto `cluster` that would make it share data there. */
export async function refuseMoveSharingData(ports: ConsumerRelocationPorts, stage: Stage, name: string, cluster: string): Promise<void> {
  await refuseSharedData(ports, cluster, stage, name, await readStageRegistration(ports, stage, name));
}

/** The consumer world factory — resolved fresh at every step from the apps row + the registration. */
export function consumerWorld(ports: ConsumerRelocationPorts, appId: string): WorldOf {
  return async (ctx: StepCtx): Promise<RelocationWorld> => {
    const ac = loadAppCluster(ctx.db, appId);
    // The unit's stage is the row's own and travels with it: the chain is read for the CLUSTER's
    // domain and the UNIT's stage, on the source and on the target alike.
    const unitApex = async (): Promise<string> => unitApexFromChain(await ports.registrations.readClusterValueFiles(ac.domain, ac.stage));
    const namespace = consumerNamespace(ac.name, ac.stage);
    const image = ports.dbtoolsImage ?? "";
    // The registration + PVC list are read lazily, per closure: a restore resolves this world while
    // the unit's registration is deliberately ABSENT (offboarded), and must not fail on it.
    const registrationInputs = async (): Promise<{ name: string; namespace: string; stage: typeof ac.stage; databases: string[]; services: ConsumerStageRegistration["services"]; mongodb: ConsumerStageRegistration["mongodb"]; redis: RedisMode; image: string }> => {
      const reg = await readStageRegistration(ports, ac.stage, ac.name);
      return { name: ac.name, namespace, stage: ac.stage, databases: servedSharedDatabases(reg, ac.stage), services: reg.services, mongodb: reg.mongodb, redis: reg.redis ?? "shared", image };
    };
    const jobInputs = async (): Promise<Awaited<ReturnType<typeof registrationInputs>> & { pvcs: string[] }> => {
      const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
      return { ...(await registrationInputs()), pvcs: await clusterReader.listPersistentVolumeClaims(namespace) };
    };
    // Whose files the tarred claims hold on `clusterId`: the user of the workloads mounting them there.
    const claimsIdentityOn = async (clusterId: string, inputs: { pvcs: readonly string[]; services: ConsumerStageRegistration["services"]; mongodb: ConsumerStageRegistration["mongodb"] }) => {
      const claims = tarredClaims(inputs);
      return claims.length > 0 ? claimsIdentity(namespace, claims, await (await ports.resolver.resolve(clusterId)).clusterReader.listClaimUsers(namespace)) : undefined;
    };
    const appName = consumerArgoAppName(ac.name, ac.stage);
    return {
      unit: ac.name,
      kindWord: "consumer",
      stage: ac.stage,
      installation: () => resolveMasterCluster(ctx.db).domain,
      sourceClusterId: ac.clusterId,
      sourceDomain: ac.domain,
      sourceCluster: ac.clusterName,
      publicUrl: `https://${consumerUnitHost(ac.host, ac.stage, await unitApex())}`,
      namespaces: [namespace],
      homeNamespace: namespace,
      setQuiesced: (q, runId) => ports.registrations.setQuiesced(ac.stage, ac.name, q, runId),
      readRegistrationYaml: async () => serializePointer(ConsumerRegistrationSchema, await readStageRegistration(ports, ac.stage, ac.name)),
      watchConverged: async (c, clusterId, intent) => {
        const entry = await readStageRegistration(ports, ac.stage, ac.name);
        const quiesced = intent === "quiesced";
        if (entry.quiesced !== quiesced) throw errValidation(`consumer ${ac.name} registration no longer requests the ${intent} render`);
        await watchConsumerSwitch(ports, c, { clusterId, appName, chart: { repoURL: entry.repoURL, chartPath: entry.chartPath } }, "quiesced", quiesced, intent);
        c.log("meta", `Application ${appName} is Synced + Healthy — the consumer render is ${intent}`);
      },
      dumpJobs: async (folder, registrationYaml) => {
        const inputs = await jobInputs();
        const pvcUser = await claimsIdentityOn(ac.clusterId, inputs);
        return consumerDumpJobs({ ...inputs, ...(pvcUser !== undefined ? { pvcUser } : {}), folder, registrationYaml });
      },
      expectedDumpEntries: async () => consumerExpectedDumpEntries(await jobInputs()),
      // What comes back is what the generation holds, written into the claims that stand on the TARGET:
      // the old cluster may have lost the namespace to an offboard, released it to a move, or be gone.
      // The target renders quiesced, at replicas 0, so a StatefulSet there has made none of its claims;
      // the restore makes each one it names from its template. A claim the generation holds that the
      // target neither has nor names is refused by name before any store is written, so a restore never
      // settles green over data it left behind. The files are written as the workloads that will read
      // them there, whose templates already stand.
      restoreJobs: async (folder, ctx, targetClusterId) => {
        const inputs = await registrationInputs();
        const held = parseClaimLines(await runRelocationJob(ports, ctx, targetClusterId, consumerGenerationClaimsJob({ name: ac.name, namespace, folder, image })));
        const claims = tarredClaims({ pvcs: held, services: inputs.services, mongodb: inputs.mongodb });
        for (const claim of held.filter((c) => !claims.includes(c))) {
          ctx.log("meta", `${claim} in the generation ${folder} left out: it is the data directory of a store the restore loads from its own dump, and a tar of it is no consistent copy`);
        }
        const { clusterReader } = await ports.resolver.resolve(targetClusterId);
        const standing = await clusterReader.listPersistentVolumeClaims(namespace);
        const unplaced: string[] = [];
        for (const claim of claims.filter((c) => !standing.includes(c))) {
          if (await clusterReader.createStatefulSetClaim(namespace, claim)) ctx.log("meta", `claim ${claim} made in ${namespace} from the template of the StatefulSet that names it, which the quiesced render had not made`);
          else unplaced.push(claim);
        }
        if (unplaced.length > 0) {
          throw errValidation(`the generation ${folder} holds ${unplaced.join(", ")}, and no claim of that name stands in ${namespace} on ${targetOf(ctx, targetClusterId).cluster}, nor does a StatefulSet there name it, so the restore stops before any store is written`);
        }
        const pvcUser = await claimsIdentityOn(targetClusterId, { pvcs: claims, services: inputs.services, mongodb: inputs.mongodb });
        return consumerRestoreJobs({ ...inputs, pvcs: claims, ...(pvcUser !== undefined ? { pvcUser } : {}), folder });
      },
      verifyCompletenessJobs: async (folder) => consumerVerifyCompletenessJobs({ ...(await registrationInputs()), folder }),
      sourceDbListJob: async () => {
        const i = await jobInputs();
        return consumerSourceDbListJob({ name: i.name, stage: i.stage, databases: i.databases, services: i.services, mongodb: i.mongodb, image });
      },
      clearSourceJobs: async () => {
        const i = await jobInputs();
        return consumerClearSourceJobs({ name: i.name, stage: i.stage, databases: i.databases, services: i.services, mongodb: i.mongodb, image });
      },
      // ---- migrate/restore closures -------------------------------------------------------
      provisionTarget: async (c, target, dumpedRegistrationYaml) => {
        // THE FIVE FENCES ARE NOT WRITTEN HERE. The isolation AppProject, the admission policy with
        // its Binding, the argo-sync grant and the two `<name>-build` grants are all rendered from
        // the unit's registration by hostyour-cloud (clusters/units/reconciler,
        // clusters/units/admissionpolicy, clusters/inventories/consumer-build), and every one of
        // those ApplicationSets selects on the registration's `cluster` — so the REPOINT that
        // follows this step is what moves them onto the target, exactly as an onboard's first
        // commit is what raises them. What is left below is the one object no chart renders, and it
        // has to stand BEFORE the flip for the reason the flip itself gives: the moment the
        // registration names the target, the target generates the unit's Application and tries to
        // clone its repository.
        const { clusterReader, argoNamespace } = await ports.resolver.resolve(target.clusterId);
        // The repository credential must exist in the TARGET's ArgoCD namespace or a private repo
        // can never sync there. A public repo (no sealed credential) simply has none to carry over.
        const repoURLOfRow = ctx.db.select({ repoUrl: apps.repoUrl }).from(apps).where(eq(apps.id, appId)).get()?.repoUrl;
        const credentialId = await unitRepoCredentialId({ repoURL: repoURLOfRow, githubApp: ports.githubApp, owners: (org) => readOwnerIdentity(ctx.db, org), store: ctx.creds, signal: ctx.signal });
        let access = "";
        if (credentialId) {
          if (!ports.repoCredential) throw errValidation(`provision-target for "${ac.name}" requires the repository-credential writer but none is wired — ArgoCD on the target could never fetch the private consumer repo`);
          // ABSENT is a state here — a migrate may run this step after the source registration was
          // released, which is why the repoURL has the apps-row fallback. A FAILED read is not:
          // readRegistration answers null for absent and throws on an unreadable branch/file, and
          // that throw propagates so the step is retried rather than sealing a credential against a
          // repository nobody read. A restore has no live registration at all and rides the dumped
          // bytes in.
          const reg = dumpedRegistrationYaml !== undefined
            ? ConsumerRegistrationSchema.parse(parseRegistration(dumpedRegistrationYaml))
            : (await ports.registrations.readRegistration(ac.stage, ac.name))?.entry ?? null;
          const repoURL = reg?.repoURL ?? ctx.db.select({ repoUrl: apps.repoUrl }).from(apps).where(eq(apps.id, appId)).get()?.repoUrl;
          if (repoURL === undefined || repoURL === null) throw errValidation(`consumer "${ac.name}" has no repo URL on record — the credential would be sealed against a repository nobody can name`);
          const kept = await keepUnitRepoCredential(
            { store: c.creds, repoCredential: ports.repoCredential },
            { name: ac.name, stage: ac.stage, repoURL, credentialId, argoNamespace },
            { purpose: "relocation:provision-target", runId: c.runId },
          );
          access = kept.identity === "github-app"
            ? `its repository through the App's credential template in ${argoNamespace}; `
            : `repository credential in ${argoNamespace}; `;
        }
        // The mark below is set on DEPARTURE and says "this unit is leaving this cluster". A namespace
        // that already stands here can therefore carry one from an earlier move OFF this cluster — a
        // move back after an aborted one is exactly that case — and a mark left standing would make the
        // next ordinary offboard keep the unit's databases behind. Clearing it is part of arming the
        // target. A cluster the unit has never been on has no namespace yet (ArgoCD creates it on the
        // first sync) and nothing to clear.
        if ((await clusterReader.smoke(namespace)).namespaceExists) {
          await clusterReader.annotateNamespace(namespace, { [CLAIM_RELOCATING_ANNOTATION]: null });
        }
        c.log("meta", `target ${target.cluster} provisioned for ${ac.name} — ${access}the isolation AppProject, the admission policy and the argo-sync grant are rendered from the registration and follow the repoint`);
      },
      repoint: async (c, target) => {
        // The mark FIRST, on the SOURCE namespace, because the flip below IS a delete on the source:
        // the source appset stops selecting the unit, ArgoCD deletes the Application with its
        // resources-finalizer, and every ServiceClaim of the unit falls with it. The service-provisioner
        // tears a claim down by dropping its user AND its databases, so without the mark the source data
        // would be gone here — before restore has read anything and before verify-source-released
        // measures. Marked, the teardown keeps the databases and the bucket; clear-source drops them at
        // the end, once the target holds a verified copy. The namespace is the carrier because a consumer
        // has no CR and its namespace outlives the prune (Delete=false, set by the appset's
        // managedNamespaceMetadata).
        // Checked again here, after the plan, because another unit may have been placed on the target
        // since; the flip below is what makes the target serve this unit its databases.
        await refuseMoveSharingData(ports, ac.stage, ac.name, target.cluster);
        const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
        await clusterReader.annotateNamespace(namespace, { [CLAIM_RELOCATING_ANNOTATION]: "true" });
        c.log("meta", `source namespace ${namespace} annotated ${CLAIM_RELOCATING_ANNOTATION} — the ServiceClaim teardown that the repoint sets off now keeps the data instead of dropping it`);
        const { commit } = await ports.registrations.setCluster(ac.stage, ac.name, target.cluster, c.runId);
        c.checkpoint({ commit });
        c.log("meta", `registration for ${ac.name} repointed ${ac.domain} -> ${target.domain} (${commit}) — the source appset stops generating the Application and the target starts`);
      },
      writeRegistrationFromDump: async (c, registrationYaml, target) => {
        const entry = ConsumerRegistrationSchema.parse(parseRegistration(registrationYaml));
        // The attested fqdn and the SMTP entry travel with the unit, and each is held unique at
        // onboarding (G19, G29). While the unit was gone another may have taken either; restoring it
        // then would admit one name on two clusters, or give the stage two mail senders.
        if (entry.fqdn !== undefined) {
          const taken = (await ports.registrations.listAttestedFqdns({ unit: entry.name, stage: ac.stage })).find((a) => a.fqdn === entry.fqdn);
          if (taken) throw errValidation(`the dumped registration attests the fqdn ${entry.fqdn}, which ${taken.unit} now attests at ${taken.stage} — free it there before restoring ${entry.name}`);
        }
        // The data travels with the unit too: a restore onto a cluster where another registration is
        // served the same database, or holds the same Redis keys or channels, would join the two.
        await refuseSharedData(ports, target.cluster, ac.stage, entry.name, {
          services: entry.services ?? [], databases: entry.databases ?? [], mongodb: entry.mongodb ?? "shared",
          ...(entry.redis !== undefined ? { redis: entry.redis } : {}),
          ...(entry.keyPatterns !== undefined ? { keyPatterns: entry.keyPatterns } : {}),
          ...(entry.channelPatterns !== undefined ? { channelPatterns: entry.channelPatterns } : {}),
        });
        if (entry.smtpEntry !== undefined) {
          const sender = (await ports.registrations.listSmtpSenders(ac.stage)).find((s) => s.unit !== entry.name);
          if (sender) throw errValidation(`the dumped registration makes ${entry.name} the mail sender at ${ac.stage}, which ${sender.unit} is now — a stage has one sender; offboard it there before restoring ${entry.name}`);
        }
        // The dumped registration is re-committed AT THE TARGET, closed: the unit deploys quiesced,
        // its claims provision empty stores, and only after the data is restored does open-access lift it.
        await ports.registrations.commitRegistration({
          unit: { name: entry.name, repoURL: entry.repoURL, ...(entry.owner ? { owner: entry.owner } : {}), ...(entry.onboardedAt ? { onboardedAt: entry.onboardedAt } : {}), suspended: entry.suspended, quiesced: true },
          builds: [],
          // The unit's OWN stage: the dump is re-committed at the path it was dumped from, on the
          // target cluster, whatever stage that cluster's map carries.
          deploy: { stage: ac.stage, chartPath: entry.chartPath!, cluster: target.cluster, host: entry.host ?? ac.name, databases: entry.databases ?? [],
                    // The redis grant travels with the unit, for the reason the size below does: a
                    // move must land it with what it ran with. Dropped here, the unit would arrive
                    // granted NOTHING and its ACL user would be refused its own keys.
                    keyPatterns: entry.keyPatterns ?? [], channelPatterns: entry.channelPatterns ?? [], services: entry.services ?? [],
                    // The size travels with the unit: a move must land it on the instance it ran on,
                    // not on whatever the default happens to be at the destination.
                    size: entry.size ?? "small", mongodb: entry.mongodb ?? "shared",
                    // Each data part's size and volume pin travel the same way: the claims the
                    // restore creates must be the size the dump came from.
                    ...(entry.sizes !== undefined ? { sizes: entry.sizes } : {}),
                    ...(entry.volumes !== undefined ? { volumes: entry.volumes } : {}),
                    // The namespace ceiling travels the same way, and as the FIGURES the dump carried
                    // rather than re-resolved from the table: a move must not re-price the unit, and a
                    // restore onto an installation whose table has since changed must land the unit on
                    // what it ran with. No fallback for a dump without one: quota is part of the deploy
                    // group, so a stage registration missing it does not parse two lines above.
                    quota: entry.quota!,
                    // The extra public name and the mail sender's SMTP entry were attested at onboarding
                    // and travel with the unit the same way. Dropped here, a restored sender would also
                    // lose the stage's relay target, which follows the sender in this very commit.
                    ...(entry.fqdn !== undefined ? { fqdn: entry.fqdn } : {}),
                    ...(entry.smtpEntry !== undefined ? { smtpEntry: entry.smtpEntry } : {}) },
          runId: c.runId,
        });
        c.log("meta", `registration for ${entry.name} re-committed from the dump onto ${target.cluster}, quiesced — the target deploys closed until the data is back`);
      },
      verifySourceHandleReleased: async (c) => {
        const { argoReader, argoNamespace } = await ports.resolver.resolve(ac.clusterId);
        await argoReader.refreshApplicationSet(argoNamespace, "consumer-apps");
        const gone = (s: ArgoAppStatus): boolean => s.health === "Missing";
        const status = await argoReader.watchApplication(argoNamespace, appName, gone, { timeoutMs: ports.argoWatchTimeoutMs, signal: c.signal });
        if (!gone(status)) {
          throw errValidation(`the source still generates Application ${appName} (health=${status.health}) — the source has not released the unit, refusing to continue`);
        }
        c.log("meta", `source Application ${appName} is gone — the source released the unit`);
      },
      // The chain is (the TARGET cluster's domain, the UNIT's stage).
      dnsRecordNames: async (_c, target) => [consumerUnitHost(ac.host, ac.stage, unitApexFromChain(await ports.registrations.readClusterValueFiles(target.domain, ac.stage)))],
      clearSourceCluster: async (c) => {
        const { clusterReader, argoNamespace } = await ports.resolver.resolve(ac.clusterId);
        // The source's three GitOps-rendered objects — its AppProject, its admission policy and its
        // argo-sync grant — go the way they came: the repoint left the source's name in `leaving`, the
        // fence ApplicationSets kept generating them off it while the source Application was still
        // being deleted (an Application whose project is pruned under it is one ArgoCD refuses to
        // reconcile, deletion included — hostyour-cloud#214), and taking the name off now, with the
        // source Application long gone (verify-source-released), is what prunes them. No hand delete
        // beside it: a second writer of a generated object is what left the earlier belt standing.
        const left = await ports.registrations.clearLeaving(ac.stage, ac.name, c.runId);
        c.log("meta", left
          ? `registration for ${ac.name} (${ac.stage}) no longer names the source it left (${left.commit}) — the source's fence ApplicationSets prune its AppProject, admission policy and argo-sync grant`
          : `registration for ${ac.name} (${ac.stage}) names no source it is leaving — nothing to take off (resume)`);
        // The two objects no reconciler renders stay the Manager's to delete, as at offboard: the
        // repository credential, and the namespace (Delete=false on it by design, so the prune leaves it).
        if (ports.repoCredential) await ports.repoCredential.deleteRepoCredential(argoNamespace, consumerRepoCredentialName(ac.name, ac.stage));
        const { deleted } = await clusterReader.deleteNamespace(namespace);
        c.log("meta", `source cluster cleared for ${ac.name} at ${ac.stage} — repository credential removed, fences left to the prune; namespace ${namespace} ${deleted ? "deleted" : "already absent"} (the per-consumer PostgreSQL and the PVCs fall with it)`);
        // The one thing a move does NOT take off the source. The objectstore claim's teardown skipped
        // its DeleteBucket at repoint (Garage refuses it on a non-empty bucket, and the retrying
        // finalizer would have kept the source Application standing past verify-source-released), and
        // nothing here can finish the job: the claim's key is revoked and its credential Secret went
        // with the namespace, so no job of this run can reach the bucket, and the Manager carries no
        // Garage admin credential. Said in the run log because this is the record the operator gets.
        // The read is tolerated: a registration this step cannot read must not fail the last step of a
        // move — the service-provisioner logs the same fact with the bucket's exact name.
      },
      record: async (c, target) => {
        localTx(c, (tx) => tx.update(apps).set({ clusterId: target.clusterId, status: "active", lastRunId: c.runId, updatedAt: new Date() }).where(eq(apps.id, appId)).run());
        c.log("meta", `consumer ${ac.name} recorded on cluster ${target.clusterId} (active)`);
      },
      workloadExempt: async () => consumerStoreWorkload(await readStageRegistration(ports, ac.stage, ac.name), appName),
    };
  };
}
