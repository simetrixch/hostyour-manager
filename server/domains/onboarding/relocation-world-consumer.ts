// The CONSUMER shape of the relocation carrier: how ONE consumer app quiesces, dumps, provisions,
// repoints, restores, verifies and clears — everything relocation.ts's kind-neutral steps reach
// through the RelocationWorld. A consumer is one Application, one namespace, one AppProject; its
// stores are its Mongo databases[], its per-consumer PostgreSQL, its claim bucket and its PVCs.
import { eq } from "drizzle-orm";
import type { StepCtx } from "../../executor/types.ts";
import type { ArgoAppStatus } from "../../adapters/kube/port.ts";
import { apps } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { Stage } from "../../../shared/enums.ts";
import { consumerArgoAppName, ConsumerRegistrationSchema, type ConsumerStageRegistration } from "../../../shared/consumer.ts";
import { localTx } from "../../executor/stepkit.ts";
import { clusterShortName } from "../inventory/cluster-marking.ts";
import { serializePointer, parseFlatYaml, type Registry } from "./registry.ts";
import { loadAppCluster, type LifecyclePorts } from "./lifecycle.ts";
import { unitApexFromChain, consumerAdmissionPolicyName, renderConsumerAdmissionPolicy } from "./admission-policy.ts";
import { renderConsumerAppProject } from "./appproject.ts";
import { renderBuildRbac, renderConsumerArgoSync } from "./build-rbac.ts";
import { renderConsumerRepoCredential, consumerRepoCredentialName } from "./repo-credential.ts";
import { consumerUnitHost } from "./unit-dns.ts";
import type { RepoCredentialWriter, BuildRbacWriter } from "../../adapters/kube/port.ts";
import { CLAIM_RELOCATING_ANNOTATION } from "../../adapters/kube/port.ts";
import type { RelocationPorts, RelocationWorld, WorldOf } from "./relocation.ts";
import {
  consumerDumpJobs,
  consumerRestoreJobs,
  consumerVerifyCompletenessJobs,
  consumerSourceDbListJob,
  consumerClearSourceJobs,
  consumerExpectedDumpEntries,
} from "./relocation-jobs-consumer.ts";

/** The consumer relocation port set: the kind-neutral relocation ports PLUS the consumer registry
 *  (LifecyclePorts, so the shared attest-target step composes) and the target-side provisioning
 *  writers the migrate/restore run kinds re-arm on the target. */
export interface ConsumerRelocationPorts extends RelocationPorts, LifecyclePorts {
  registry: Registry;
  platformRepoURL: string;
  /** Optional but UNCONDITIONALLY needed by provision-target — absent ⇒ fail loud (offboard's shape). */
  buildRbac?: BuildRbacWriter;
  repoCredential?: RepoCredentialWriter;
}

/** The registration's deploy group, read STRICTLY: the relocation of a consumer is meaningless
 *  without its data scope, so an absent/registration-less unit throws rather than dumping nothing. */
async function readStageRegistration(ports: ConsumerRelocationPorts, stage: Stage, name: string): Promise<ConsumerStageRegistration> {
  const read = await ports.registry.readRegistration(stage, name);
  if (!read) throw errValidation(`consumer "${name}" is not registered at ${stage} — nothing to relocate`);
  const e = read.entry;
  if (e.chartPath === undefined || e.cluster === undefined || e.databases === undefined || e.services === undefined || e.size === undefined || e.mongodb === undefined || e.quota === undefined) {
    throw errValidation(`registrations/${name}/${stage}.yaml carries no deploy group — a stage registration must`);
  }
  return { ...e, chartPath: e.chartPath, cluster: e.cluster, databases: e.databases, services: e.services, size: e.size, mongodb: e.mongodb, quota: e.quota };
}

/** The consumer world factory — resolved fresh at every step from the apps row + the registration. */
export function consumerWorld(ports: ConsumerRelocationPorts, appId: string): WorldOf {
  return async (ctx: StepCtx): Promise<RelocationWorld> => {
    const ac = loadAppCluster(ctx.db, appId);
    const unitApex = async (): Promise<string> => unitApexFromChain(await ports.registry.readClusterValueFiles(ac.domain, ac.stage));
    const image = ports.dbtoolsImage ?? "";
    // The registration + PVC list are read lazily, per closure: a restore resolves this world while
    // the unit's registration is deliberately ABSENT (offboarded), and must not fail on it.
    const jobInputs = async (): Promise<{ name: string; stage: typeof ac.stage; databases: string[]; services: ConsumerStageRegistration["services"]; pvcs: string[]; image: string }> => {
      const reg = await readStageRegistration(ports, ac.stage, ac.name);
      const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
      const pvcs = await clusterReader.listPersistentVolumeClaims(ac.name);
      return { name: ac.name, stage: ac.stage, databases: reg.databases, services: reg.services, pvcs, image };
    };
    const converged = (s: ArgoAppStatus): boolean => s.sync === "Synced" && s.health === "Healthy";
    const appName = consumerArgoAppName(ac.name, ac.stage);
    return {
      unit: ac.name,
      kindWord: "consumer",
      stage: ac.stage,
      sourceClusterId: ac.clusterId,
      sourceDomain: ac.domain,
      sourceCluster: clusterShortName(ac.domain),
      publicHost: consumerUnitHost(ac.name, await unitApex()),
      namespaces: [ac.name],
      homeNamespace: ac.name,
      setQuiesced: (q, runId) => ports.registry.setQuiesced(ac.stage, ac.name, q, runId),
      readRegistrationYaml: async () => serializePointer(ConsumerRegistrationSchema, await readStageRegistration(ports, ac.stage, ac.name)),
      watchConverged: async (c, clusterId, intent) => {
        const { argoReader, argoNamespace } = await ports.resolver.resolve(clusterId);
        const status = await argoReader.watchApplication(argoNamespace, appName, converged, { timeoutMs: ports.argoWatchTimeoutMs, signal: c.signal });
        if (!converged(status)) {
          throw errValidation(`Application ${appName} did not reach Synced/Healthy on the ${intent} render — last seen sync=${status.sync}, health=${status.health}${status.message ? ` (${status.message})` : ""}`);
        }
        c.log("meta", `Application ${appName} is Synced + Healthy — the consumer render is ${intent}`);
      },
      dumpJobs: async (registrationYaml) => consumerDumpJobs({ ...(await jobInputs()), registrationYaml }),
      expectedDumpEntries: async () => consumerExpectedDumpEntries(await jobInputs()),
      restoreJobs: async () => consumerRestoreJobs(await jobInputs()),
      verifyCompletenessJobs: async () => consumerVerifyCompletenessJobs(await jobInputs()),
      sourceDbListJob: async () => {
        const i = await jobInputs();
        return consumerSourceDbListJob({ name: i.name, stage: i.stage, databases: i.databases, services: i.services, image });
      },
      clearSourceJobs: async () => {
        const i = await jobInputs();
        return consumerClearSourceJobs({ name: i.name, stage: i.stage, databases: i.databases, services: i.services, image });
      },
      // ---- migrate/restore closures -------------------------------------------------------
      provisionTarget: async (c, target, dumpedRegistrationYaml) => {
        // ABSENT is a state here — a migrate may run this step after the source registration was
        // released, which is why the repoURL below has the apps-row fallback. A FAILED read is not:
        // the registration is the ONLY record of the attested fqdn grant, so swallowing the failure
        // would render the target policy without it and the moved unit's own Ingress (which carries
        // the granted rule) would be refused there. readRegistration answers null for absent and
        // throws on an unreadable branch/file — the throw propagates and the step is retried.
        const reg = dumpedRegistrationYaml !== undefined
          ? ConsumerRegistrationSchema.parse(parseFlatYaml(dumpedRegistrationYaml))
          : (await ports.registry.readRegistration(ac.stage, ac.name))?.entry ?? null;
        const repoURL = reg?.repoURL ?? ctx.db.select({ repoUrl: apps.repoUrl }).from(apps).where(eq(apps.id, appId)).get()?.repoUrl;
        if (repoURL === undefined || repoURL === null) throw errValidation(`consumer "${ac.name}" has no repo URL on record — the target AppProject cannot be rendered`);
        const { projectWriter, clusterReader, argoNamespace } = await ports.resolver.resolve(target.clusterId);
        await projectWriter.applyAppProject(argoNamespace, renderConsumerAppProject({ name: ac.name, namespace: ac.name, repoURL, platformRepoURL: ports.platformRepoURL, argoNamespace }));
        const targetApex = unitApexFromChain(await ports.registry.readClusterValueFiles(target.domain, target.stage));
        // The attested fqdn moves WITH the unit: the registration is the grant's record, so the
        // target cluster's policy admits the same extra FQDN the source's did.
        // The attested services move with the unit for the same reason the fqdn does: they decide
        // which platform namespace labels the target policy admits, and the target cluster's
        // ApplicationSet stamps them off this same registration.
        const { policy, binding } = renderConsumerAdmissionPolicy({ name: ac.name, namespace: ac.name, unitApex: targetApex, argoAppName: appName, services: reg?.services ?? [], ...(reg?.fqdn !== undefined ? { fqdn: reg.fqdn } : {}) });
        await clusterReader.applyAdmissionPolicy(policy, binding);
        if (!ports.buildRbac) throw errValidation(`provision-target for "${ac.name}" requires the build RBAC writer but none is wired — the release pipelines could never sync the moved unit`);
        await ports.buildRbac.applyBuildRbac(renderBuildRbac({ name: ac.name, argoNamespace }));
        // The repository credential must exist in the TARGET's ArgoCD namespace or a private repo
        // can never sync there. A public repo (no sealed credential) simply has none to carry over.
        const row = ctx.db.select({ repoCredentialId: apps.repoCredentialId }).from(apps).where(eq(apps.id, appId)).get();
        if (row?.repoCredentialId) {
          if (!ports.repoCredential) throw errValidation(`provision-target for "${ac.name}" requires the repository-credential writer but none is wired — ArgoCD on the target could never fetch the private consumer repo`);
          const pat = await c.creds.open(row.repoCredentialId, { purpose: "relocation:provision-target", runId: c.runId });
          try {
            await ports.repoCredential.applyRepoCredential(renderConsumerRepoCredential({ consumerName: ac.name, argoNamespace, repoURL, pat: pat.toString("utf8") }));
          } finally {
            pat.fill(0);
          }
        }
        // The mark below is set on DEPARTURE and says "this unit is leaving this cluster". A namespace
        // that already stands here can therefore carry one from an earlier move OFF this cluster — a
        // move back after an aborted one is exactly that case — and a mark left standing would make the
        // next ordinary offboard keep the unit's databases behind. Clearing it is part of arming the
        // target. A cluster the unit has never been on has no namespace yet (ArgoCD creates it on the
        // first sync) and nothing to clear.
        if ((await clusterReader.smoke(ac.name)).namespaceExists) {
          await clusterReader.annotateNamespace(ac.name, { [CLAIM_RELOCATING_ANNOTATION]: null });
        }
        c.log("meta", `target ${target.cluster} provisioned for ${ac.name} — AppProject, admission policy, build grants${row?.repoCredentialId ? ", repository credential" : ""} in ${argoNamespace}`);
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
        const { clusterReader } = await ports.resolver.resolve(ac.clusterId);
        await clusterReader.annotateNamespace(ac.name, { [CLAIM_RELOCATING_ANNOTATION]: "true" });
        c.log("meta", `source namespace ${ac.name} annotated ${CLAIM_RELOCATING_ANNOTATION} — the ServiceClaim teardown that the repoint sets off now keeps the data instead of dropping it`);
        const { commit } = await ports.registry.setCluster(ac.stage, ac.name, target.cluster, c.runId);
        c.checkpoint({ commit });
        c.log("meta", `registration for ${ac.name} repointed ${ac.domain} -> ${target.domain} (${commit}) — the source appset stops generating the Application and the target starts`);
      },
      writeRegistrationFromDump: async (c, registrationYaml, target) => {
        const entry = ConsumerRegistrationSchema.parse(parseFlatYaml(registrationYaml));
        // The dumped registration is re-committed AT THE TARGET, closed: the unit deploys quiesced,
        // its claims provision empty stores, and only after the data is restored does open-access lift it.
        await ports.registry.commitRegistration({
          unit: { name: entry.name, repoURL: entry.repoURL, ...(entry.repoCredentialId ? { repoCredentialId: entry.repoCredentialId } : {}), ...(entry.owner ? { owner: entry.owner } : {}), ...(entry.onboardedAt ? { onboardedAt: entry.onboardedAt } : {}), suspended: entry.suspended, quiesced: true },
          builds: [],
          deploy: { stage: target.stage, chartPath: entry.chartPath!, cluster: target.cluster, databases: entry.databases ?? [], services: entry.services ?? [],
                    // The size travels with the unit: a move must land it on the instance it ran on,
                    // not on whatever the default happens to be at the destination.
                    size: entry.size ?? "small", mongodb: entry.mongodb ?? "shared",
                    // The namespace ceiling travels the same way, and as the FIGURES the dump carried
                    // rather than re-resolved from the table: a move must not re-price the unit, and a
                    // restore onto an installation whose table has since changed must land the unit on
                    // what it ran with. No fallback for a dump without one: quota is part of the deploy
                    // group, so a stage registration missing it does not parse two lines above.
                    quota: entry.quota! },
          runId: c.runId,
        });
        c.log("meta", `registration for ${entry.name} re-committed from the dump onto ${target.cluster}, quiesced — the target deploys closed until the data is back`);
      },
      verifySourceHandleReleased: async (c) => {
        const { argoReader, argoNamespace } = await ports.resolver.resolve(ac.clusterId);
        const gone = (s: ArgoAppStatus): boolean => s.health === "Missing";
        const status = await argoReader.watchApplication(argoNamespace, appName, gone, { timeoutMs: ports.argoWatchTimeoutMs, signal: c.signal });
        if (!gone(status)) {
          throw errValidation(`the source still generates Application ${appName} (health=${status.health}) — the source has not released the unit, refusing to continue`);
        }
        c.log("meta", `source Application ${appName} is gone — the source released the unit`);
      },
      dnsRecordName: async (_c, target) => consumerUnitHost(ac.name, unitApexFromChain(await ports.registry.readClusterValueFiles(target.domain, target.stage))),
      clearSourceCluster: async (c) => {
        const { projectWriter, clusterReader, argoNamespace } = await ports.resolver.resolve(ac.clusterId);
        await clusterReader.deleteAdmissionPolicy(consumerAdmissionPolicyName(ac.name));
        await projectWriter.deleteAppProject(argoNamespace, ac.name);
        // The argo-sync grant ONLY. The other two grants renderBuildRbac carries live in the stage-free
        // `<name>-build` namespace, which does not move with the unit and is the one place its release
        // PipelineRun is created — deleting them here would leave the unit unable to build on its new
        // cluster. The tenant world clears its source the same way (one argo-sync grant, nothing else).
        if (ports.buildRbac) await ports.buildRbac.deleteBuildRbac([renderConsumerArgoSync({ name: ac.name, argoNamespace })]);
        if (ports.repoCredential) await ports.repoCredential.deleteRepoCredential(argoNamespace, consumerRepoCredentialName(ac.name));
        const { deleted } = await clusterReader.deleteNamespace(ac.name);
        c.log("meta", `source cluster cleared for ${ac.name} — admission policy, AppProject, argo-sync grant, repository credential removed; namespace ${ac.name} ${deleted ? "deleted" : "already absent"} (the per-consumer PostgreSQL and the PVCs fall with it)`);
        // The one thing a move does NOT take off the source. The objectstore claim's teardown skipped
        // its DeleteBucket at repoint (Garage refuses it on a non-empty bucket, and the retrying
        // finalizer would have kept the source Application standing past verify-source-released), and
        // nothing here can finish the job: the claim's key is revoked and its credential Secret went
        // with the namespace, so no job of this run can reach the bucket, and the Controller carries no
        // Garage admin credential. Said in the run log because this is the record the operator gets.
        // The read is tolerated: a registration this step cannot read must not fail the last step of a
        // move — the service-provisioner logs the same fact with the bucket's exact name.
      },
      record: async (c, target) => {
        localTx(c, (tx) => tx.update(apps).set({ clusterId: target.clusterId, status: "active", lastRunId: c.runId }).where(eq(apps.id, appId)).run());
        c.log("meta", `consumer ${ac.name} recorded on cluster ${target.clusterId} (active)`);
      },
      // The per-consumer PostgreSQL is provisioner-owned (not chart-rendered), and it DELIBERATELY
      // keeps running through a quiesce — that is what keeps its databases reachable for the dump.
      workloadExempt: (w) => w.name === "postgres" || w.name.startsWith("postgres-"),
    };
  };
}
