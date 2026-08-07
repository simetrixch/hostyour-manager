// relocation.ts — the ONE carrier behind move, backup and restore. The three verbs are
// slices of a single step vocabulary built here and in relocation-restore.ts / relocation-migrate.ts:
// backup = close access, dump every store, verify the folder, reopen (the folder STAYS); restore =
// provide the target and rebuild the unit from the folder; migrate = both halves plus the repoint
// and the one-record DNS switch. What differs per unit KIND (consumer vs tenant) is folded into ONE
// object — the RelocationWorld — resolved fresh at every step from the inventory + the registration,
// so the steps themselves can never fork into per-kind code paths that drift.
import type { Step, StepCtx } from "../../executor/types.ts";
import type { ClusterKubeResolver, JobResult, WorkloadStatus } from "../../adapters/kube/port.ts";
import type { PublicProbe } from "../../adapters/http-probe/port.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import type { Stage } from "../../../shared/enums.ts";
import { errValidation } from "../../kernel/errors.ts";
import { boxSecretData, boxSecretName, jobReadsBoxSecret, verifyDumpJob, type RelocationJob, type StorageBoxAccess } from "./relocation-jobs.ts";
import { loadActiveTargetCluster, type TargetCluster } from "./relocation-target.ts";

/** What every relocation step reaches the world through. `jobTimeoutMs` is the per-Job budget — a
 *  dump of a big store is the longest thing this domain runs. `storageBox`/`dbtoolsImage` are
 *  optional in the WIRING but mandatory for the verbs: an absent one fails the step loud (the DNS
 *  provider's shape), never a silent skip. */
export interface RelocationPorts {
  resolver: ClusterKubeResolver;
  argoWatchTimeoutMs: number;
  jobTimeoutMs: number;
  probe: PublicProbe;
  dns?: DnsProvider;
  storageBox?: StorageBoxAccess;
  dbtoolsImage?: string;
}

/** ONE unit as the relocation steps see it — the whole per-kind difference, in data and closures.
 *  Resolved by a WorldOf factory at STEP time (never frozen), so a resumed step reads the world as
 *  it stands. */
export interface RelocationWorld {
  /** The unit's one identity: the consumer name, or the tenant guid. Also the box folder name. */
  unit: string;
  kindWord: "consumer" | "tenant";
  stage: Stage;
  sourceClusterId: string;
  sourceDomain: string;
  /** The source cluster's SHORT name (what the registration's cluster field carries). */
  sourceCluster: string;
  /** The unit's public host — a consumer's `<name>.<unitApex>`, a tenant's auth member (every
   *  tenant has one), which is what verify-quiesced probes from the outside. */
  publicHost: string;
  /** Every namespace of the unit on its cluster (a consumer: one; a tenant: one per member). */
  namespaces: string[];
  /** Where the unit's secret-less jobs run (verify-dump, the registration read). */
  homeNamespace: string;
  /** Flip the registration's quiesced field — the enforced access lock, never a prune. */
  setQuiesced(quiesced: boolean, runId: string): Promise<{ commit: string }>;
  /** The unit's registration, serialized — what the dump lays into the folder so a restore can
   *  rebuild the unit after the live registration is long gone. */
  readRegistrationYaml(): Promise<string>;
  /** Wait for the unit's Application(s) to converge Synced/Healthy on the given cluster — the same
   *  wait for the quiesced and the open render (neither prunes), so intent only names the state. */
  watchConverged(ctx: StepCtx, clusterId: string, intent: string): Promise<void>;
  /** The dump job set for this unit (each job in the namespace whose Secrets it needs). */
  dumpJobs(registrationYaml: string, ctx: StepCtx): Promise<RelocationJob[]>;
  /** What a complete dump leaves on the box — what verify-dump demands. */
  expectedDumpEntries(ctx: StepCtx): Promise<string[]>;
  /** The restore job set — the dump's mirror, run on the TARGET cluster. */
  restoreJobs(ctx: StepCtx): Promise<RelocationJob[]>;
  /** The completeness listings run on the TARGET before DNS — each job compares what it can see
   *  against the box copy and fails naming what is missing. */
  verifyCompletenessJobs(ctx: StepCtx): Promise<RelocationJob[]>;
  /** List the SOURCE's databases (`DB` lines) — the data half of verify-source-released. null when
   *  the unit holds no database the ServiceClaim cascade could have destroyed (a consumer whose
   *  claims are s3/redis/registry-pull/forwardauth only, or whose mongodb databases[] is empty), so
   *  the step measures the handle alone instead of reading an empty listing as destruction. */
  sourceDbListJob(ctx: StepCtx): Promise<RelocationJob | null>;
  /** Drop the source databases + delete the box folder — the LAST thing a move does. */
  clearSourceJobs(ctx: StepCtx): Promise<RelocationJob[]>;
  /** Provision the unit's isolation on the target: a consumer's AppProject/VAP/build grants/repo
   *  credential, a tenant's member AppProjects/Tenant CR/argo-sync. Vault: NOTHING — one shared
   *  mount, never touched by a move. A RESTORE provisions from the DUMPED registration (the live one
   *  is long gone), so the dumped bytes ride in; a migrate reads the live registration and passes
   *  nothing. */
  provisionTarget(ctx: StepCtx, target: TargetCluster, dumpedRegistrationYaml?: string): Promise<void>;
  /** Flip the registration's cluster field onto the target — plus, for a tenant, annotate the source
   *  CR relocating and delete it (the annotation makes that delete a release, not a deprovision). */
  repoint(ctx: StepCtx, target: TargetCluster): Promise<void>;
  /** Re-commit the DUMPED registration onto the target, quiesced — how a restore rebuilds a unit
   *  whose live registration is long gone. */
  writeRegistrationFromDump(ctx: StepCtx, registrationYaml: string, target: TargetCluster): Promise<void>;
  /** The handle half of verify-source-released: the source no longer GENERATES the unit — a
   *  consumer's source Application is pruned, a tenant's source CR is gone. */
  verifySourceHandleReleased(ctx: StepCtx): Promise<void>;
  /** The unit's ONE public record name — what switch-dns updates, never recomposed elsewhere. The
   *  apex comes off the TARGET's values chain (where the unit will serve). */
  dnsRecordName(ctx: StepCtx, target: TargetCluster): Promise<string>;
  /** Kind-specific completeness beyond the listing jobs — a tenant proves its crypto material
   *  materialized on the target. Absent ⇒ the jobs are the whole check. */
  verifyCompletenessExtra?(ctx: StepCtx, target: TargetCluster): Promise<void>;
  /** Remove the unit's source-side cluster objects (AppProjects/policy/grants/namespaces). */
  clearSourceCluster(ctx: StepCtx): Promise<void>;
  /** Settle the inventory onto the target — always the LAST step of a move or restore. */
  record(ctx: StepCtx, target: TargetCluster): Promise<void>;
  /** Is this workload MEANT to keep running while the unit is quiesced? A consumer's per-consumer
   *  PostgreSQL is provisioner-owned, not chart-rendered, and deliberately keeps serving so its
   *  databases stay reachable for the dump. Absent ⇒ nothing is exempt. */
  workloadExempt?(w: WorkloadStatus): boolean;
}

/** The per-kind world factory the step builders close over — resolved fresh at every step. */
export type WorldOf = (ctx: StepCtx) => Promise<RelocationWorld>;

export function requireStorageBox(ports: RelocationPorts, verb: string): StorageBoxAccess {
  if (!ports.storageBox) {
    throw errValidation(`${verb} requires the Hetzner Storage Box but none is wired on this controller (STORAGE_BOX_HOST/USER/PASSWORD unset — secret/<stage>/app/storage-box) — the staging area is a mandatory part of this verb, never a silent skip`);
  }
  return ports.storageBox;
}

export function requireDbtoolsImage(ports: RelocationPorts, verb: string): string {
  if (ports.dbtoolsImage === undefined) {
    throw errValidation(`${verb} requires the dbtools job image but none is pinned on this controller (DBTOOLS_IMAGE unset — the dbtools builds[] entry of hostyour-cloud/apps/controller) — the dump and restore run as Jobs of exactly that image`);
  }
  return ports.dbtoolsImage;
}

/** Run one relocation job on `clusterId` and fail LOUD with the job's own log tail when it did not
 *  succeed — the log is the only witness a Job leaves.
 *
 *  A job that reaches the Storage Box gets its credential PLACED as a Secret in the job's own
 *  namespace here and reaped again the moment the job settles, which is why every relocation job runs
 *  through this one function. The window is the job's runtime and nothing more: the namespaces are the
 *  units' own and the platform `mongodb`, so a credential parked there permanently — or written flat
 *  onto the jobSpec, where it would also land in the pod and outlive the run by the Job's TTL — is
 *  readable by anything holding `get jobs` or `get pods` there. */
export async function runRelocationJob(ports: RelocationPorts, ctx: StepCtx, clusterId: string, job: RelocationJob): Promise<string> {
  const { clusterReader } = await ports.resolver.resolve(clusterId);
  const boxSecret = jobReadsBoxSecret(job.spec) ? boxSecretName(job.spec.name) : null;
  if (boxSecret !== null) {
    await clusterReader.applySecret(job.namespace, boxSecret, boxSecretData(requireStorageBox(ports, `job ${job.spec.name}`)));
  }
  ctx.log("meta", `running job ${job.spec.name} in ${job.namespace}`);
  let result: JobResult;
  try {
    result = await clusterReader.runJob(job.namespace, job.spec, { timeoutMs: ports.jobTimeoutMs, signal: ctx.signal });
  } finally {
    // Reaped even when the job threw or the run was aborted, and reported rather than rethrown: a
    // failed reap must not replace the job's own error, which is what an operator needs to read. The
    // Secret is named after the job, so a re-run deletes the leftover before it writes its own.
    if (boxSecret !== null) {
      await clusterReader.deleteSecret(job.namespace, boxSecret).catch((e: unknown) => {
        ctx.log("meta", `could not remove the box credential ${job.namespace}/${boxSecret} — delete it by hand: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }
  for (const line of result.logs.split("\n")) {
    if (line.trim()) ctx.log("stdout", line);
  }
  if (!result.succeeded) {
    const tail = result.logs.trim().split("\n").slice(-5).join(" | ");
    throw errValidation(`job ${job.spec.name} in ${job.namespace} did not succeed${tail ? ` — ${tail}` : " (no log collected)"}`);
  }
  return result.logs;
}

/** The workloads still ASKING for replicas — the off measurement shared with the suspend verbs:
 *  `available` cannot tell 0-of-0 from off, so the desired count is what is read. */
const stillRunning = (workloads: readonly WorkloadStatus[], exempt?: (w: WorkloadStatus) => boolean): string[] =>
  workloads.filter((w) => w.desired > 0 && !(exempt?.(w) ?? false)).map((w) => `${w.kind}/${w.name} (${w.ready}/${w.desired})`);

/** Close access: flip the registration to quiesced. The flip is a FIELD, never a prune — the
 *  ServiceClaims survive, which is precisely what keeps the databases reachable for the dump. */
export function quiesceStep(worldOf: WorldOf): Step {
  return {
    name: "quiesce",
    title: "Close access (flip the registration to quiesced)",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      const { commit } = await w.setQuiesced(true, ctx.runId);
      ctx.checkpoint({ commit });
      ctx.log("meta", `${w.kindWord} ${w.unit} flipped to quiesced (${commit}) — the charts now render replicas 0 and no Ingress while every ServiceClaim survives`);
    },
  };
}

/** Measure that access is CLOSED — enforced, not announced: wait for the quiesced render to
 *  converge, then demand (1) the public address answers nothing and (2) every unit workload asks for
 *  zero replicas. A chart that ignored the quiesced field passes the convergence wait and fails
 *  exactly here. */
export function verifyQuiescedStep(ports: RelocationPorts, worldOf: WorldOf): Step {
  return {
    name: "verify-quiesced",
    title: "Verify access is closed (public address unreachable, replicas zero)",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      await w.watchConverged(ctx, w.sourceClusterId, "quiesced");
      const url = `https://${w.publicHost}/`;
      const seen = await ports.probe.probe(url, { signal: ctx.signal });
      if (seen.reachable) {
        throw errValidation(`${w.kindWord} ${w.unit} is flagged quiesced but its public address ${url} still answers (${seen.detail}) — a write landing now would be lost after the dump, refusing to continue`);
      }
      const { clusterReader } = await ports.resolver.resolve(w.sourceClusterId);
      for (const ns of w.namespaces) {
        const smoke = await clusterReader.smoke(ns);
        if (!smoke.namespaceExists) throw errValidation(`namespace ${ns} does not exist — a quiesce switches the unit off, it never removes a namespace`);
        const running = stillRunning(smoke.workloads, w.workloadExempt?.bind(w));
        if (running.length) throw errValidation(`${w.kindWord} ${w.unit} is flagged quiesced but ${ns} still runs ${running.join(", ")}`);
      }
      ctx.checkpoint({ probed: url, detail: seen.detail, namespaces: w.namespaces });
      ctx.log("meta", `access to ${w.unit} is closed — ${url} is unreachable (${seen.detail}) and every workload across ${w.namespaces.length} namespace(s) asks for zero replicas`);
    },
  };
}

/** Dump EVERY store of the unit into its box folder — the registration, the databases, the bucket,
 *  the crypto material (a tenant) or the PVCs (a consumer), each job where its Secrets live. */
export function dumpStep(ports: RelocationPorts, worldOf: WorldOf): Step {
  return {
    name: "dump",
    title: "Dump every store into the Storage Box folder",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      requireStorageBox(ports, "dump");
      requireDbtoolsImage(ports, "dump");
      const registrationYaml = await w.readRegistrationYaml();
      const jobs = await w.dumpJobs(registrationYaml, ctx);
      for (const job of jobs) await runRelocationJob(ports, ctx, w.sourceClusterId, job);
      ctx.checkpoint({ folder: w.unit, jobs: jobs.map((j) => j.spec.name) });
      ctx.log("meta", `${w.kindWord} ${w.unit} dumped — ${jobs.length} job(s) filled the folder /${w.unit}/ on the storage box`);
    },
  };
}

/** Verify the dump: every expected folder entry stands on the box, or the run stops HERE — before
 *  anything downstream trusts a half-written folder. */
export function verifyDumpStep(ports: RelocationPorts, worldOf: WorldOf): Step {
  return {
    name: "verify-dump",
    title: "Verify the dump is complete on the Storage Box",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      requireStorageBox(ports, "verify-dump");
      const image = requireDbtoolsImage(ports, "verify-dump");
      const expected = await w.expectedDumpEntries(ctx);
      const job = verifyDumpJob({ unit: w.unit, namespace: w.homeNamespace, expected, image });
      await runRelocationJob(ports, ctx, w.sourceClusterId, job);
      ctx.checkpoint({ expected });
      ctx.log("meta", `dump of ${w.unit} verified — ${expected.join(", ")} all stand in the folder`);
    },
  };
}

/** Reopen access: flip quiesced back and wait for the running render to converge — on the SOURCE
 *  for a backup (the unit stays where it was), on the TARGET for a move or restore (the registration
 *  now points there). The box folder is untouched: keeping it is what makes the run a backup. */
export function openAccessStep(worldOf: WorldOf, on: "source" | "target", targetClusterId?: string): Step {
  return {
    name: "open-access",
    title: "Reopen access (flip the registration back from quiesced)",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      const { commit } = await w.setQuiesced(false, ctx.runId);
      const clusterId = on === "source" ? w.sourceClusterId : loadActiveTargetCluster(ctx.db, targetClusterId!, w.stage).clusterId;
      await w.watchConverged(ctx, clusterId, "running");
      ctx.checkpoint({ commit });
      ctx.log("meta", `access to ${w.unit} reopened (${commit}) — the unit serves again`);
    },
  };
}
