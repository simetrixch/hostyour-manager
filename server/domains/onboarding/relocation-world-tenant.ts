// The TENANT shape of the relocation carrier: the whole member bracket moves — every namespace,
// every AppProject, the Tenant CR, every `<guid>_*` database, the bucket, the crypto material — and
// nothing moves on its own. The delta from the consumer world is exactly the bracket: SET watches
// over the fan-out, one AppProject per member, the CR as the handle the source must release, and
// the relocating annotation that turns the source CR's delete into that release.
import { eq, and, notInArray } from "drizzle-orm";
import type { StepCtx } from "../../executor/types.ts";
import { tenants, tenantApps } from "../../db/schema/inventory.ts";
import { errValidation } from "../../kernel/errors.ts";
import { TENANT_SETTLED_STATUS, type Stage } from "../../../shared/enums.ts";
import { TenantRegistrationSchema, type TenantRegistration } from "../../../shared/tenant.ts";
import { parse as parseYaml } from "yaml";
import { localTx } from "../../executor/stepkit.ts";
import { serializePointer } from "./registry.ts";
import { loadTenantCluster, type TenantLifecyclePorts } from "./lifecycle.ts";
import { tenantSelector, allPruned, lingering } from "./tenant-lifecycle.run.ts";
import { memberAppProject, memberApplication, memberNamespace, tenantApplicationSet, tenantNamespaces } from "./tenant-fanout.ts";
import { renderTenantAppProject } from "./appproject.ts";
import { renderTenantMemberAdmissionPolicy, tenantMemberAdmissionPolicyName } from "./admission-policy.ts";
import { renderTenantArgoSync } from "./build-rbac.ts";

import { CLAIM_RELOCATING_ANNOTATION } from "../../adapters/kube/port.ts";
import { deleteTenantArgoSync } from "./tenant-teardown.ts";
import { tenantMemberHost, tenantWildcardHost } from "./unit-dns.ts";
import { syncedAt, describeUnsynced } from "./tenant-watch.ts";
import type { RelocationPorts, RelocationWorld, WorldOf } from "./relocation.ts";
import {
  tenantDumpJobs,
  tenantRestoreJobs,
  tenantVerifyCompletenessJobs,
  tenantSourceDbListJob,
  tenantClearSourceJobs,
  tenantExpectedDumpEntries,
  TENANT_CRYPTO_SECRET,
} from "./relocation-jobs.ts";
import type { TargetCluster } from "./relocation-target.ts";

/** The tenant relocation port set — the kind-neutral relocation ports over the tenant lifecycle set
 *  (TenantRegistry + resolver + the apex/DNS/argo-sync plumbing the tenant run kinds already carry). */
export interface TenantRelocationPorts extends RelocationPorts, TenantLifecyclePorts {
  platformRepoURL: string;
}

/** The tenant's registration, read strictly — a backup/migrate acts on a DEPLOYED tenant, so an
 *  absent registration is a refusal, never an empty dump. */
async function readRegistration(ports: TenantRelocationPorts, stage: Stage, guid: string): Promise<TenantRegistration> {
  const read = await ports.registry.readTenant(stage, guid);
  if (!read) throw errValidation(`tenant "${guid}" is not onboarded at ${stage} — nothing to relocate`);
  return read.entry;
}

/** The tenant's app names: the registration while one stands (the live truth), else the
 *  NOT-settled inventory rows (a restore resolves the world before its registration is back; the
 *  dumped registration takes over the moment provision-target parses it). */
async function tenantAppNames(ports: TenantRelocationPorts, ctx: StepCtx, tenantId: string, stage: Stage, guid: string): Promise<string[]> {
  const read = await ports.registry.readTenant(stage, guid);
  if (read) return read.entry.apps.map((a) => a.name);
  return ctx.db
    .select({ name: tenantApps.name })
    .from(tenantApps)
    .where(and(eq(tenantApps.tenantId, tenantId), notInArray(tenantApps.status, [...TENANT_SETTLED_STATUS])))
    .all()
    .map((r) => r.name);
}

/** The tenant world factory — resolved fresh at every step from the tenants row + the registration. */
export function tenantWorld(ports: TenantRelocationPorts, tenantId: string): WorldOf {
  return async (ctx: StepCtx): Promise<RelocationWorld> => {
    const tc = loadTenantCluster(ctx.db, tenantId);
    const apps = await tenantAppNames(ports, ctx, tenantId, tc.stage, tc.guid);
    // EVERY member of the tenant: the standing set the row records, plus one per app. The row keeps
    // the standing set alone because an app's presence is its own row and its status, so every reader
    // unions the two — and a move that used the row alone would leave each app's namespace,
    // AppProject and Application standing on the source.
    const allMembers = [...tc.members, ...apps];
    const image = ports.dbtoolsImage ?? "";
    const watchSet = (names: string[]) => async (c: StepCtx, clusterId: string, intent: string): Promise<void> => {
      const until = syncedAt(names);
      const { argoReader, argoNamespace } = await ports.resolver.resolve(clusterId);
      const byName = await argoReader.watchApplicationSet(argoNamespace, names, until, { timeoutMs: ports.argoWatchTimeoutMs, signal: c.signal, labelSelector: tenantSelector(tc.guid) });
      if (!until(byName)) throw errValidation(`tenant ${tc.guid} fan-out did not converge on the ${intent} render — ${describeUnsynced(names, byName)}`);
      c.log("meta", `tenant ${tc.guid} fan-out is Synced + Healthy (${names.length} Application(s)) — the render is ${intent}`);
    };
    const applyIsolation = async (c: StepCtx, target: TargetCluster, memberNames: string[], applications: string[]): Promise<void> => {
      const { projectWriter, clusterReader, argoNamespace } = await ports.resolver.resolve(target.clusterId);
      for (const member of memberNames) {
        await projectWriter.applyAppProject(argoNamespace, renderTenantAppProject({ guid: tc.guid, member, argoNamespace, catalogRepoUrl: ports.catalogRepoUrl, platformRepoURL: ports.platformRepoURL, cluster: target.cluster }));
        // The member's admission boundary moves WITH the member, exactly as the consumer world
        // carries its policy: the target's ApplicationSet stamps the same labels off the same
        // registration, so the target policy admits the same managed namespace the source's did.
        const { policy, binding } = renderTenantMemberAdmissionPolicy({ guid: tc.guid, member, stage: tc.stage });
        await clusterReader.applyAdmissionPolicy(policy, binding);
      }
      if (!ports.buildRbac) throw errValidation(`provision-target for tenant ${tc.guid} requires the build RBAC writer but none is wired`);
      // The grant is re-armed with NO subject: which units may sync this tenant is computed from a
      // validated render at create-tenant, which a relocation does not re-run — a bump then reaches
      // the moved tenant on ArgoCD's own poll instead of a pipeline-driven sync.
      await ports.buildRbac.applyBuildRbac([renderTenantArgoSync({ guid: tc.guid, applications, argoNamespace, units: [] })]);
      c.log("meta", `${memberNames.length} member AppProject(s) + admission policies + the argo-sync grant applied in ${argoNamespace}, destination pinned to ${target.cluster}`);
    };
    return {
      unit: tc.guid,
      kindWord: "tenant",
      stage: tc.stage,
      sourceClusterId: tc.clusterId,
      sourceDomain: tc.domain,
      sourceCluster: (await ports.registry.readTenant(tc.stage, tc.guid))?.entry.cluster ?? "",
      // Every tenant has its auth member, and every member sits one level below the subdomain — so
      // the auth host is the probe target that exists for EVERY tenant.
      publicHost: tenantMemberHost(tc.identityProvider, tc.subdomain, await ports.resolveUnitApex(tc.domain, tc.stage)),
      namespaces: tenantNamespaces(allMembers, tc.guid),
      homeNamespace: memberNamespace(tc.guid, tc.identityProvider),
      setQuiesced: (q, runId) => ports.registry.setTenantQuiesced(tc.stage, tc.guid, q, runId),
      readRegistrationYaml: async () => serializePointer(TenantRegistrationSchema, await readRegistration(ports, tc.stage, tc.guid)),
      watchConverged: async (c, clusterId, intent) => watchSet(tenantApplicationSet(allMembers, tc.guid, tc.stage))(c, clusterId, intent),
      dumpJobs: async (registrationYaml) => tenantDumpJobs({ guid: tc.guid, stage: tc.stage, apps, identityProvider: tc.identityProvider, image, registrationYaml }),
      expectedDumpEntries: async () => tenantExpectedDumpEntries(apps),
      restoreJobs: async () => tenantRestoreJobs({ guid: tc.guid, stage: tc.stage, apps, identityProvider: tc.identityProvider, image }),
      verifyCompletenessJobs: async () => tenantVerifyCompletenessJobs({ guid: tc.guid, stage: tc.stage, apps, identityProvider: tc.identityProvider, image }),
      sourceDbListJob: async () => tenantSourceDbListJob({ guid: tc.guid, stage: tc.stage, image }),
      clearSourceJobs: async () => tenantClearSourceJobs({ guid: tc.guid, stage: tc.stage, image }),
      provisionTarget: async (c, target, dumpedRegistrationYaml) => {
        const entry = dumpedRegistrationYaml !== undefined ? TenantRegistrationSchema.parse(parseYaml(dumpedRegistrationYaml)) : await readRegistration(ports, tc.stage, tc.guid);
        // The DUMPED registration's apps, not this run's: a restore reconstructs the tenant the box
        // holds, whose app set may differ from whatever the inventory still says.
        const members = [...tc.members, ...entry.apps.map((a) => a.name)];
        await applyIsolation(c, target, members, tenantApplicationSet(members, tc.guid, tc.stage));
        const { clusterReader } = await ports.resolver.resolve(target.clusterId);
        // The claim mark is set on DEPARTURE (see repoint), so a member namespace still standing on
        // this cluster can carry one from an earlier move away from it — and a mark left behind would
        // make the next ordinary offboard keep that member's databases. Clear it wherever a namespace
        // stands; on a first arrival ArgoCD has not created them yet and there is nothing to clear.
        for (const ns of tenantNamespaces(members, tc.guid)) {
          if ((await clusterReader.smoke(ns)).namespaceExists) {
            await clusterReader.annotateNamespace(ns, { [CLAIM_RELOCATING_ANNOTATION]: null });
          }
        }
        c.log("meta", `tenant ${tc.guid} isolation applied on ${target.cluster} (${members.length} member(s): ${tc.members.length} standing + ${entry.apps.length} app(s))`);
      },
      repoint: async (c, target) => {
        // ONE mark, BEFORE the flip, and it is the one that saves the data. Every MEMBER namespace
        // carries what the SERVICE-PROVISIONER would deprovision: each member chart renders a
        // ServiceClaim naming that member's databases, the flip prunes the member Applications, and
        // the resources-finalizer takes those claims with them — so without this mark the move's own
        // repoint drops the databases it is moving.
        // There used to be a second mark, on the Tenant CR, for what a reconciler would have
        // deprovisioned. Nothing reconciles that CR and it no longer exists; the Vault entry it stood
        // for is untouched by a move anyway (one shared KV mount), and the databases were never its to
        // save — this mark is what saves them, and always was.
        // The member namespace stays readable for that decision even while the cascade deletes it: a
        // namespace cannot finish terminating while a claim inside it still holds the provisioner's
        // finalizer.
        const { clusterReader } = await ports.resolver.resolve(tc.clusterId);
        const sourceNamespaces = tenantNamespaces(allMembers, tc.guid);
        for (const ns of sourceNamespaces) {
          await clusterReader.annotateNamespace(ns, { [CLAIM_RELOCATING_ANNOTATION]: "true" });
        }
        c.log("meta", `${sourceNamespaces.length} source member namespace(s) annotated ${CLAIM_RELOCATING_ANNOTATION} — the ServiceClaim teardown that the repoint sets off now keeps the member databases`);
        const { commit } = await ports.registry.setTenantCluster(tc.stage, tc.guid, target.cluster, c.runId);
        c.checkpoint({ commit });
        c.log("meta", `tenant ${tc.guid} repointed onto ${target.cluster} (${commit}) — the source appset stops matching this registration and prunes the member Applications, which is the release verify-source-released measures`);
      },
      writeRegistrationFromDump: async (c, registrationYaml, target) => {
        const entry = TenantRegistrationSchema.parse(parseYaml(registrationYaml));
        // Re-committed AT THE TARGET, closed: the fan-out deploys quiesced, the claims provision
        // empty stores, and open-access lifts it only after the data is back and verified.
        const { commit } = await ports.registry.commitTenant({
          stage: target.stage,
          guid: tc.guid,
          registration: { ...entry, cluster: target.cluster, quiesced: true },
          runId: c.runId,
        });
        c.checkpoint({ commit });
        c.log("meta", `tenant registration for ${tc.guid} re-committed from the dump onto ${target.cluster}, quiesced (${commit})`);
      },
      verifySourceHandleReleased: async (c) => {
        // The tenant twin of the consumer's check, on the same evidence and for the same reason: the
        // source must no longer GENERATE the unit, or two live copies could serve and write at once.
        // What generates a tenant is the fan-out — one Application per member, produced by the source
        // cluster's appset from the registration — so the release IS those Applications being pruned,
        // which the repoint sets off by flipping the registration's cluster field.
        //
        // It used to watch the source Tenant CR instead. That was a weak check even while a reconciler
        // existed (the Controller deleted the CR itself one line earlier, so the watch confirmed its
        // own delete) and an empty one without: nothing holds the object, so it vanishes at once and
        // the watch always passed. The member Applications are what the source actually stops
        // producing.
        const names = [...tc.members, ...apps].map((m) => memberApplication(tc.guid, m, tc.stage));
        const { argoReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const status = await argoReader.watchApplicationSet(argoNamespace, names, allPruned(names), {
          timeoutMs: ports.argoWatchTimeoutMs,
          signal: c.signal,
          labelSelector: tenantSelector(tc.guid),
        });
        if (!allPruned(names)(status)) {
          throw errValidation(
            `the source still generates ${lingering(status)} for tenant ${tc.guid} — the source has not released the tenant, refusing to continue`,
          );
        }
        c.log("meta", `source fan-out for ${tc.guid} is pruned (${names.length} Application(s)) — the source released the tenant`);
      },
      dnsRecordName: async (_c, target) => tenantWildcardHost(tc.subdomain, await ports.resolveUnitApex(target.domain, target.stage)),
      verifyCompletenessExtra: async (c, target) => {
        // The crypto material never travels (Vault is one shared mount) — what must be PROVEN is
        // that the target's ESO materialized it, or every member boots into SecretSyncedError.
        const { clusterReader } = await ports.resolver.resolve(target.clusterId);
        const key = await clusterReader.readSecretValue(memberNamespace(tc.guid, tc.identityProvider), TENANT_CRYPTO_SECRET, "AUTH_JWT_PUBLIC_KEY");
        if (key === null) {
          throw errValidation(`the tenant's crypto material did not materialize on ${target.cluster} (${TENANT_CRYPTO_SECRET} in ${memberNamespace(tc.guid, tc.identityProvider)} has no AUTH_JWT_PUBLIC_KEY) — the identity would not survive, aborting before DNS`);
        }
        c.log("meta", `crypto material verified on ${target.cluster} — the tenant keeps its identity (same Vault entry, same keys)`);
      },
      clearSourceCluster: async (c) => {
        const { projectWriter, clusterReader, argoNamespace } = await ports.resolver.resolve(tc.clusterId);
        const members = allMembers;
        let deleted = 0;
        for (const member of members) {
          if ((await projectWriter.deleteAppProject(argoNamespace, memberAppProject(tc.guid, member))).deleted) deleted++;
          // The member's admission policy goes with its AppProject — cluster-scoped, so nothing else
          // ever reaps it, and the target cluster carries its own copy since provision-target.
          await clusterReader.deleteAdmissionPolicy(tenantMemberAdmissionPolicyName(tc.guid, member));
        }
        const grantRemoved = await deleteTenantArgoSync(ports, tc.guid, argoNamespace);
        // The namespaces by LABEL, unioned with the derivable names — the same complete reap the
        // purge makes, because a member nobody records still carries the label.
        const labelled = await clusterReader.listNamespaces(tenantSelector(tc.guid));
        const namespaces = [...new Set([...labelled, ...members.map((m) => memberNamespace(tc.guid, m))])];
        const gone: string[] = [];
        for (const ns of namespaces) {
          if ((await clusterReader.deleteNamespace(ns)).deleted) gone.push(ns);
        }
        c.log("meta", `source cluster cleared for ${tc.guid} — ${deleted} AppProject(s) + the admission policies deleted, argo-sync grant ${grantRemoved ? "deleted" : "already absent"}, ${gone.length} of ${namespaces.length} namespace(s) deleted`);
      },
      record: async (c, target) => {
        const entry = await ports.registry.readTenant(target.stage, tc.guid);
        const appNames = entry?.entry.apps.map((a) => a.name) ?? apps;
        localTx(c, (tx) => {
          tx.update(tenants).set({ clusterId: target.clusterId, status: "active", suspended: false, lastRunId: c.runId, updatedAt: new Date() }).where(eq(tenants.id, tenantId)).run();
          for (const name of appNames) {
            tx.update(tenantApps).set({ status: "active", lastRunId: c.runId }).where(and(eq(tenantApps.tenantId, tenantId), eq(tenantApps.name, name))).run();
          }
        });
        c.log("meta", `tenant ${tc.guid} recorded on cluster ${target.clusterId} (active, ${appNames.length} app(s))`);
      },
    };
  };
}
