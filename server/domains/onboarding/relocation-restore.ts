// The TARGET-side steps of the relocation carrier — the "second half" of the sequence that IS the restore
// verb, and that a migrate composes after its dump half: provide the target, rebuild the unit from
// the box folder, prove completeness BEFORE DNS, switch the one record, smoke, and settle the
// inventory. Kind differences all live behind the RelocationWorld.
import type { Step, StepCtx } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";
import { assertDeployState } from "./lifecycle.ts";
import { provisionUnitDns } from "./unit-dns.ts";
import { readRegistrationJob, readRegistrationFromLogs, MONGO_NAMESPACE } from "./relocation-jobs.ts";
import { loadActiveTargetCluster, type TargetCluster } from "./relocation-target.ts";
import { requireDbtoolsImage, requireStorageBox, runRelocationJob, type RelocationPorts, type WorldOf } from "./relocation.ts";

/** The target of this run, resolved fresh at every step (same-stage + active, like the plan said). */
export function targetOf(ctx: StepCtx, worldStage: string, targetClusterId: string): TargetCluster {
  return loadActiveTargetCluster(ctx.db, targetClusterId, worldStage as TargetCluster["stage"]);
}

/** attest-target for a RESTORE (step 0): the TARGET cluster is the one this run mutates, so its
 *  deploy-state is what is attested — the source may legitimately be gone. */
export function attestRestoreTargetStep(ports: RelocationPorts, worldOf: WorldOf, targetClusterId: string): Step {
  return {
    name: "attest-target",
    title: "Attest the target cluster (deploy-state fresh)",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      const target = targetOf(ctx, w.stage, targetClusterId);
      const { clusterReader } = await ports.resolver.resolve(target.clusterId);
      const state = assertDeployState(await clusterReader.readDeployState(), target.domain, target.stage, w.kindWord);
      ctx.log("meta", `target ${target.domain} (${target.stage}) attested for the restore of ${w.unit} — deploy-state generation ${state.generation}`);
    },
  };
}

/** provision-target for a MIGRATE: the unit's isolation on the target, from the LIVE registration
 *  (it still stands — the repoint comes after). */
export function provisionTargetStep(worldOf: WorldOf, targetClusterId: string): Step {
  return {
    name: "provision-target",
    title: "Provision the unit's isolation on the target cluster",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      await w.provisionTarget(ctx, targetOf(ctx, w.stage, targetClusterId));
    },
  };
}

/** provision-target for a RESTORE: read the DUMPED registration off the box (a job on the target —
 *  the unit's own namespaces do not exist yet, so it runs in the platform mongodb namespace),
 *  provision the isolation it names, and re-commit it onto the target, quiesced. One step, because
 *  the registration bytes read here are exactly what the two writes need, and a resumed step
 *  re-reads them rather than trusting a stale copy. */
export function provisionTargetFromDumpStep(ports: RelocationPorts, worldOf: WorldOf, targetClusterId: string): Step {
  return {
    name: "provision-target",
    title: "Read the dumped registration and provision the target cluster",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      const target = targetOf(ctx, w.stage, targetClusterId);
      requireStorageBox(ports, "restore");
      const image = requireDbtoolsImage(ports, "restore");
      const logs = await runRelocationJob(ports, ctx, target.clusterId, readRegistrationJob({ unit: w.unit, namespace: MONGO_NAMESPACE, image }));
      const registrationYaml = readRegistrationFromLogs(logs);
      if (registrationYaml === null || registrationYaml.trim() === "") {
        throw errValidation(`the box folder /${w.unit}/ carries no readable registration.yaml — a restore rebuilds the unit FROM its dump, and this folder has none`);
      }
      await w.provisionTarget(ctx, target, registrationYaml);
      await w.writeRegistrationFromDump(ctx, registrationYaml, target);
    },
  };
}

/** Wait for the unit to converge on the TARGET — still quiesced: the claims provision empty stores
 *  while nothing runs and nothing serves, which is the state a restore may write into. */
export function watchTargetStep(worldOf: WorldOf, targetClusterId: string): Step {
  return {
    name: "watch",
    title: "Wait for the unit to converge on the target (still closed)",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      await w.watchConverged(ctx, targetOf(ctx, w.stage, targetClusterId).clusterId, "quiesced");
    },
  };
}

/** Restore every store from the box folder into the target. */
export function restoreStep(ports: RelocationPorts, worldOf: WorldOf, targetClusterId: string): Step {
  return {
    name: "restore",
    title: "Restore every store from the Storage Box folder",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      requireStorageBox(ports, "restore");
      requireDbtoolsImage(ports, "restore");
      const target = targetOf(ctx, w.stage, targetClusterId);
      const jobs = await w.restoreJobs(ctx);
      for (const job of jobs) await runRelocationJob(ports, ctx, target.clusterId, job);
      ctx.checkpoint({ jobs: jobs.map((j) => j.spec.name) });
      ctx.log("meta", `${w.kindWord} ${w.unit} restored on ${target.cluster} — ${jobs.length} job(s) replayed the folder /${w.unit}/`);
    },
  };
}

/** Completeness BEFORE DNS: every dumped database stands on the target, the bucket matches the box
 *  copy, and (a tenant) the crypto material materialized. A failure aborts the run right here —
 *  the address never switches onto an incomplete unit. */
export function verifyCompletenessStep(ports: RelocationPorts, worldOf: WorldOf, targetClusterId: string): Step {
  return {
    name: "verify-completeness",
    title: "Verify the target holds everything the dump holds (before DNS)",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      const target = targetOf(ctx, w.stage, targetClusterId);
      const jobs = await w.verifyCompletenessJobs(ctx);
      for (const job of jobs) await runRelocationJob(ports, ctx, target.clusterId, job);
      await w.verifyCompletenessExtra?.(ctx, target);
      ctx.checkpoint({ jobs: jobs.map((j) => j.spec.name), complete: true });
      ctx.log("meta", `completeness verified on ${target.cluster} — every store the dump names is present; DNS may switch`);
    },
  };
}

/** Switch the unit's ONE record onto the target cluster's address — a content update of exactly the
 *  record the unit already owns (a move is a DNS change and nothing more). */
export function switchDnsStep(ports: RelocationPorts, worldOf: WorldOf, targetClusterId: string, verb: string): Step {
  return {
    name: "switch-dns",
    title: "Switch the unit's one DNS record to the target cluster",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      const target = targetOf(ctx, w.stage, targetClusterId);
      const recordName = await w.dnsRecordName(ctx, target);
      // The one caller that overwrites a foreign address: the record answers with the SOURCE cluster
      // until this step, and moving it onto the target is the whole of the switch.
      await provisionUnitDns(ctx, { dns: ports.dns, unit: w.unit, recordName, clusterFqdn: target.domain, verb, overwriteAddress: true });
    },
  };
}

/** Smoke every unit namespace on the TARGET — still quiesced, so the check is presence + secrets,
 *  never replica counts: the namespaces exist, no workload is failing, every ExternalSecret is Ready. */
export function targetSmokeStep(ports: RelocationPorts, worldOf: WorldOf, targetClusterId: string): Step {
  return {
    name: "smoke",
    title: "Smoke-check every unit namespace on the target",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      const target = targetOf(ctx, w.stage, targetClusterId);
      const { clusterReader } = await ports.resolver.resolve(target.clusterId);
      for (const ns of w.namespaces) {
        const smoke = await clusterReader.smoke(ns);
        if (!smoke.namespaceExists) throw errValidation(`namespace ${ns} does not exist on ${target.cluster} after the sync`);
        const failing = smoke.workloads.filter((x) => !x.available);
        if (failing.length) throw errValidation(`workloads not available in ${ns} on ${target.cluster}: ${failing.map((x) => `${x.kind}/${x.name}${x.message ? ` (${x.message})` : ""}`).join(", ")}`);
        if (!smoke.externalSecretsReady) throw errValidation(`ExternalSecrets are not all Ready in ${ns} on ${target.cluster} — that namespace's secrets did not materialize`);
      }
      ctx.checkpoint({ namespaces: w.namespaces });
      ctx.log("meta", `smoke ok across ${w.namespaces.length} namespace(s) on ${target.cluster}`);
    },
  };
}

/** Settle the inventory onto the target — ALWAYS the last step: a row claiming the unit moved while
 *  any step above could still fail would name a cluster the unit is not on. */
export function recordStep(worldOf: WorldOf, targetClusterId: string, what: string): Step {
  return {
    name: "record",
    title: `Record the ${what} in inventory`,
    run: async (ctx) => {
      const w = await worldOf(ctx);
      await w.record(ctx, targetOf(ctx, w.stage, targetClusterId));
    },
  };
}
