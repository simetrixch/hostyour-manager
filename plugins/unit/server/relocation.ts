// relocation.ts — the ONE carrier behind move, backup and restore. The three run kinds are
// slices of a single step vocabulary built here and in relocation-restore.ts / relocation-migrate.ts:
// backup = close access, dump every store into a new generation, verify it, reopen (the generation
// STAYS); restore = provide the target and rebuild the unit from the generation the operator picked;
// migrate = both halves plus the repoint and the one-record DNS switch, restoring from the generation
// it took. What differs per unit KIND (consumer vs tenant) is folded into ONE
// object — the RelocationWorld — resolved fresh at every step from the inventory + the registration,
// so the steps themselves can never fork into per-kind code paths that drift.
import type { Cleanup, Step, StepCtx } from "#core/server/executor/types.ts";
import type { ClusterKubeResolver, JobResult, WorkloadStatus } from "#core/server/adapters/kube/port.ts";
import type { PublicProbe } from "./adapters/http-probe/port.ts";
import type { DnsProvider } from "#core/server/adapters/dns/port.ts";
import type { BackupTrigger, Stage } from "#core/shared/enums.ts";
import { errValidation } from "#core/server/kernel/errors.ts";
import { findBackup, findBackupOfRun, recordBackupFinished, recordBackupStarted, type BackupUnit, type UnitBackup } from "#core/server/db/unit-backups.ts";
import {
  boxSecretData, boxSecretName, generationFolder, generationId, generationManifest, jobReadsBoxSecret, parseSha256Lines,
  purgeGenerationJob, verifyDumpJob, writeManifestJob, MONGO_NAMESPACE, type RelocationJob, type StorageBoxAccess,
} from "./relocation-jobs.ts";
import { loadActiveTargetCluster, type TargetCluster } from "./relocation-target.ts";

/** What every relocation step reaches the world through. `jobTimeoutMs` is the per-Job budget — a
 *  dump of a big store is the longest thing this domain runs. `storageBox`/`dbtoolsImage` are
 *  optional in the WIRING but mandatory for the run kinds: an absent one fails the step loud (the DNS
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
  /** The unit's one identity: the consumer name, or the tenant guid. */
  unit: string;
  kindWord: "consumer" | "tenant";
  stage: Stage;
  /** The installation the unit belongs to — the master's domain, the first folder of its backups.
   *  Read when a generation is opened, and only then. */
  installation(): string;
  sourceClusterId: string;
  sourceDomain: string;
  /** The source cluster's SHORT name (what the registration's cluster field carries). */
  sourceCluster: string;
  /** The unit's public base URL — a consumer's `https://<label>.<stage apex>`, a tenant's IdP member
   *  (every tenant has one) at the address its routing gives it, which is what verify-quiesced
   *  probes from the outside. */
  publicUrl: string;
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
  /** The dump job set for this unit, writing into the generation `folder` (each job in the namespace
   *  whose Secrets it needs). */
  dumpJobs(folder: string, registrationYaml: string, ctx: StepCtx): Promise<RelocationJob[]>;
  /** What a complete dump leaves in a generation — what verify-dump demands, the manifest aside. */
  expectedDumpEntries(ctx: StepCtx): Promise<string[]>;
  /** The restore job set — the dump's mirror, reading the generation `folder` on the TARGET cluster,
   *  whose id it is handed so it can read what stands there. */
  restoreJobs(folder: string, ctx: StepCtx, targetClusterId: string): Promise<RelocationJob[]>;
  /** The completeness listings run on the TARGET before DNS — each job compares what it can see
   *  against the generation `folder` and fails naming what is missing. */
  verifyCompletenessJobs(folder: string, ctx: StepCtx): Promise<RelocationJob[]>;
  /** List the SOURCE's databases (`DB` lines) — the data half of verify-source-released. null when
   *  the unit holds no database the ServiceClaim cascade could have destroyed (a consumer whose
   *  claims are s3/redis/registry-pull/forwardauth only, or whose mongodb databases[] is empty), so
   *  the step measures the handle alone instead of reading an empty listing as destruction. */
  sourceDbListJob(ctx: StepCtx): Promise<RelocationJob | null>;
  /** Drop the source databases — the LAST thing a move does. */
  clearSourceJobs(ctx: StepCtx): Promise<RelocationJob[]>;
  /** Arm the target with what no chart of the platform repository can render for it: a consumer's
   *  repository credential (its five fences come off its registration, so the repoint after this
   *  step is what raises them on the target), a tenant's member AppProjects/Tenant CR/argo-sync
   *  (nothing renders registrations/<guid>/…, so all of it is the Manager's). Vault: NOTHING — one
   *  shared mount, never touched by a move. A RESTORE provisions from the DUMPED registration (the
   *  live one is long gone), so the dumped bytes ride in; a migrate reads the live registration and
   *  passes nothing. */
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

/** Which generation a target-side step reads: the one this run took (a move), or the one the operator
 *  picked (a restore). */
export type GenerationOf = (ctx: StepCtx, w: RelocationWorld) => UnitBackup;

/** The unit a world is, as the book of backups keys it. */
export const backupUnitOf = (w: RelocationWorld): BackupUnit => ({ kind: w.kindWord, unit: w.unit, stage: w.stage });

/** The generation this run took of the world's unit — what a move restores from. */
export const generationOfThisRun: GenerationOf = (ctx, w) => {
  const g = findBackupOfRun(ctx.db, ctx.runId, backupUnitOf(w));
  if (!g) throw errValidation(`run ${ctx.runId} took no backup generation of ${w.kindWord} ${w.unit} — its dump opens one before anything reads it`);
  return g;
};

/** The generation the operator picked — what a restore reads, and only a written and verified one. */
export function pickedGeneration(generation: string): GenerationOf {
  return (ctx, w) => {
    const g = findBackup(ctx.db, { kind: w.kindWord, unit: w.unit, stage: w.stage, generation });
    if (!g) throw errValidation(`${w.kindWord} ${w.unit} (${w.stage}) has no backup generation ${generation}`);
    if (g.state !== "ok") throw errValidation(`generation ${generation} of ${w.kindWord} ${w.unit} is ${g.state} — only a written and verified generation is restored`);
    return g;
  };
}

export function requireStorageBox(ports: RelocationPorts, runKind: string): StorageBoxAccess {
  if (!ports.storageBox) {
    throw errValidation(`${runKind} requires the Hetzner Storage Box but none is wired on this manager (STORAGE_BOX_HOST/USER/PASSWORD unset — secret/<stage>/app/storage-box) — the staging area is a mandatory part of this run kind, never a silent skip`);
  }
  return ports.storageBox;
}

export function requireDbtoolsImage(ports: RelocationPorts, runKind: string): string {
  if (ports.dbtoolsImage === undefined) {
    throw errValidation(`${runKind} requires the dbtools job image but none is pinned on this manager (DBTOOLS_IMAGE unset — the dbtools builds[] entry of hostyour-cloud/apps/manager) — the dump and restore run as Jobs of exactly that image`);
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
    const ended = result.ended !== undefined ? `: ${result.ended}` : "";
    throw errValidation(`job ${job.spec.name} in ${job.namespace} did not succeed${ended}${tail ? ` — its last lines: ${tail}` : " (no log collected)"}`);
  }
  return result.logs;
}

/** The workloads still ASKING for replicas — the off measurement shared with the suspend run kinds:
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
      const url = `${w.publicUrl}/`;
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

/** The generation this run writes of the world's unit: entered in the book of backups the first time,
 *  the same one again when the step resumes. `inverse` is armed on the run, so an abort deletes the
 *  generation while it is unfinished. */
function openGeneration(ctx: StepCtx, w: RelocationWorld, trigger: BackupTrigger, inverse?: Cleanup): UnitBackup {
  const taken = findBackupOfRun(ctx.db, ctx.runId, backupUnitOf(w));
  if (taken) return taken;
  const generation = generationId(new Date());
  const folder = generationFolder({ installation: w.installation(), stage: w.stage, kind: w.kindWord, unit: w.unit, generation });
  recordBackupStarted(ctx.db, { ...backupUnitOf(w), generation, folder, trigger, runId: ctx.runId });
  if (inverse) ctx.registerCleanup(inverse);
  return generationOfThisRun(ctx, w);
}

/** Dump every store of the unit into the generation, the manifest with its checksums last. */
async function dumpInto(ports: RelocationPorts, ctx: StepCtx, w: RelocationWorld, g: UnitBackup, image: string): Promise<{ jobs: string[]; sums: number }> {
  const registrationYaml = await w.readRegistrationYaml();
  const jobs = await w.dumpJobs(g.folder, registrationYaml, ctx);
  const sums: string[] = [];
  for (const job of jobs) sums.push(...parseSha256Lines(await runRelocationJob(ports, ctx, w.sourceClusterId, job)));
  const manifest = generationManifest({ ...g, kind: w.kindWord, installation: w.installation(), stores: await w.expectedDumpEntries(ctx) }, sums);
  await runRelocationJob(ports, ctx, w.sourceClusterId, writeManifestJob({ unit: w.unit, folder: g.folder, namespace: w.homeNamespace, manifest, image }));
  return { jobs: jobs.map((j) => j.spec.name), sums: sums.length };
}

/** Prove every expected entry stands in the generation, the manifest included, and only then enter
 *  it as restorable. */
async function verifyInto(ports: RelocationPorts, ctx: StepCtx, w: RelocationWorld, g: UnitBackup, image: string): Promise<string[]> {
  const expected = [...(await w.expectedDumpEntries(ctx)), "manifest.txt"];
  await runRelocationJob(ports, ctx, w.sourceClusterId, verifyDumpJob({ unit: w.unit, folder: g.folder, namespace: w.homeNamespace, expected, image }));
  recordBackupFinished(ctx.db, g, { state: "ok" });
  return expected;
}

/** Delete an unfinished generation from the box and mark it failed with `detail`. A delete that fails
 *  is said in the book as well and thrown, because the folder then still stands on the box. */
async function discardGeneration(ports: RelocationPorts, ctx: StepCtx, w: RelocationWorld, g: UnitBackup, detail: string): Promise<void> {
  const image = requireDbtoolsImage(ports, DISCARD_GENERATION);
  try {
    await runRelocationJob(ports, ctx, w.sourceClusterId, purgeGenerationJob({ unit: w.unit, folder: g.folder, namespace: MONGO_NAMESPACE, image }));
  } catch (e) {
    recordBackupFinished(ctx.db, g, { state: "failed", detail: `${detail} — and the folder ${g.folder}/ could not be deleted: ${e instanceof Error ? e.message : String(e)}` });
    throw e;
  }
  recordBackupFinished(ctx.db, g, { state: "failed", detail });
}

/** Dump EVERY store of the unit into a NEW generation on the box — the registration, the databases,
 *  the bucket, the crypto material (a tenant) or the PVCs (a consumer), each job where its Secrets
 *  live — and lay the manifest last, with the checksum of every file a job hashed. */
export function dumpStep(ports: RelocationPorts, worldOf: WorldOf, trigger: BackupTrigger): Step {
  return {
    name: "dump",
    title: "Dump every store into a new backup generation on the Storage Box",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      requireStorageBox(ports, "dump");
      const image = requireDbtoolsImage(ports, "dump");
      const g = openGeneration(ctx, w, trigger, discardGenerationCleanup(ports, worldOf));
      const done = await dumpInto(ports, ctx, w, g, image);
      ctx.checkpoint({ generation: g.generation, jobs: done.jobs });
      ctx.log("meta", `${w.kindWord} ${w.unit} dumped — ${done.jobs.length} job(s) filled the generation ${g.folder}/ on the storage box, and its manifest carries ${done.sums} checksum(s)`);
    },
  };
}

/** Verify the dump: every expected entry stands in the generation, the manifest included, or the run
 *  stops HERE — before anything downstream trusts a half-written generation. Only now is the
 *  generation entered as restorable. */
export function verifyDumpStep(ports: RelocationPorts, worldOf: WorldOf): Step {
  return {
    name: "verify-dump",
    title: "Verify the generation is complete on the Storage Box",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      requireStorageBox(ports, "verify-dump");
      const image = requireDbtoolsImage(ports, "verify-dump");
      const g = generationOfThisRun(ctx, w);
      const expected = await verifyInto(ports, ctx, w, g, image);
      ctx.checkpoint({ expected, generation: g.generation });
      ctx.log("meta", `generation ${g.generation} of ${w.unit} verified — ${expected.join(", ")} all stand in ${g.folder}/, and it is a restorable backup from now on`);
    },
  };
}

/** Take ONE generation of the unit while it keeps serving — the dump of a Backup without closing
 *  access, its manifest and its verification — and settle it in the book either way. A write that
 *  lands during the dump may or may not be in it; the Backup run is the frozen copy. A failed
 *  generation is deleted from the box before the failure is thrown. */
export async function takeOnlineGeneration(ports: RelocationPorts, ctx: StepCtx, w: RelocationWorld, trigger: BackupTrigger): Promise<UnitBackup> {
  requireStorageBox(ports, `the ${trigger} backup`);
  const image = requireDbtoolsImage(ports, `the ${trigger} backup`);
  // Armed although a failure below deletes the generation itself: a Manager that dies mid-dump runs
  // no catch, and only the abort's cleanup then takes the `taking` row and its folder away.
  const g = openGeneration(ctx, w, trigger, discardGenerationCleanup(ports, () => Promise.resolve(w)));
  try {
    await dumpInto(ports, ctx, w, g, image);
    await verifyInto(ports, ctx, w, g, image);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await discardGeneration(ports, ctx, w, g, detail).catch((d: unknown) => ctx.log("meta", `the failed generation ${g.folder}/ of ${w.unit} could not be deleted — delete it by hand: ${d instanceof Error ? d.message : String(d)}`));
    throw e;
  }
  return generationOfThisRun(ctx, w);
}

/** The name the dump step arms its inverse under; the run definition supplies the cleanup itself. */
export const DISCARD_GENERATION = "discard-generation";

/** The inverse of the dump, for an aborted run of one unit. */
export function discardGenerationCleanup(ports: RelocationPorts, worldOf: WorldOf): Cleanup {
  return discardGenerationsCleanup(ports, () => [worldOf]);
}

/** The inverse of the dump, for an aborted run: every generation the run opened of the units
 *  `worldsOf` names that never became `ok` is deleted from the box and marked failed. A verified one
 *  stays, because it is a complete backup whatever failed after it. A unit that cannot be discarded
 *  fails the cleanup, and a second abort runs it again past the units already settled. */
export function discardGenerationsCleanup(ports: RelocationPorts, worldsOf: (ctx: StepCtx) => WorldOf[]): Cleanup {
  return {
    name: DISCARD_GENERATION,
    title: "Delete the unfinished backup generation from the Storage Box",
    run: async (ctx) => {
      for (const worldOf of worldsOf(ctx)) {
        const w = await worldOf(ctx);
        const g = findBackupOfRun(ctx.db, ctx.runId, backupUnitOf(w));
        if (!g || g.state !== "taking") {
          ctx.log("meta", g ? `generation ${g.generation} of ${w.unit} is ${g.state} — it stays` : `this run opened no generation of ${w.unit} — nothing to delete`);
          continue;
        }
        await discardGeneration(ports, ctx, w, g, `run ${ctx.runId} was aborted before the generation was verified`);
        ctx.log("meta", `unfinished generation ${g.folder}/ deleted from the storage box and marked failed`);
      }
    },
  };
}

/** Reopen access: flip quiesced back and wait for the running render to converge — on the SOURCE
 *  for a backup (the unit stays where it was), on the TARGET for a move or restore (the registration
 *  now points there). The generation is untouched: keeping it is what makes the run a backup. */
export function openAccessStep(worldOf: WorldOf, on: "source" | "target", targetClusterId?: string): Step {
  return {
    name: "open-access",
    title: "Reopen access (flip the registration back from quiesced)",
    run: async (ctx) => {
      const w = await worldOf(ctx);
      const { commit } = await w.setQuiesced(false, ctx.runId);
      const clusterId = on === "source" ? w.sourceClusterId : loadActiveTargetCluster(ctx.db, targetClusterId!).clusterId;
      await w.watchConverged(ctx, clusterId, "running");
      ctx.checkpoint({ commit });
      ctx.log("meta", `access to ${w.unit} reopened (${commit}) — the unit serves again`);
    },
  };
}
