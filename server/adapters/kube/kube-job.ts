// The batch/v1 Job runner behind ClusterReader.runJob (kube.ts) — its own module because the Job
// lifecycle (replace a leftover, create, poll to completion, collect the pod log) is a self-contained
// machine the reader only delegates to. Same IO discipline as kube.ts: thin shells over the client,
// every non-404 failure surfaced as UPSTREAM with the API server's own message.
import type { BatchV1Api, CoreV1Api } from "@kubernetes/client-node";
import type { JobSpec, JobResult } from "./port.ts";
import { isNotFound, upstream } from "./kube.ts";

/** Abortable sleep — resolves early (never rejects) on abort, mirroring kube.ts's. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface JobClients {
  batch: BatchV1Api;
  core: CoreV1Api;
  pollMs: number;
  /** Upper bound on the delete-and-wait in deleteJobIfPresent (default DELETE_WAIT_MS).
   *  Overridable for tests; the production reader takes the default. */
  deleteWaitMs?: number;
}

/** How long a Job delete may wait for the object to be GONE before failing loud. Foreground
 *  propagation normally clears a Job in seconds (the pod's default termination grace is 30s); a
 *  Job that is still present after this bound is stuck Terminating — a held finalizer or an
 *  unreachable node — and waiting longer would pin the calling run in `running`, holding its
 *  run_locks, with no way out but a cancel. */
const DELETE_WAIT_MS = 60_000;

/** Run ONE Job to completion: replace any leftover of the same name (the resumed-step case), create,
 *  poll until succeeded/failed/timeout/abort, then collect the pod log. A FINISHED Job is left behind
 *  under a TTL so the cluster keeps a short-lived trace and reaps it itself; a Job the poll walked
 *  away from (timeout/abort) is deleted here, because the TTL only starts once a Job finishes. */
export async function runKubeJob(c: JobClients, namespace: string, spec: JobSpec, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<JobResult> {
  await deleteJobIfPresent(c, namespace, spec.name, opts.signal);
  // An abort during the leftover delete-wait skips the wait, so the old Job may still be
  // terminating — creating the new one now would 409 against it. The caller reads the abort
  // off its own signal; this result only says no Job ran.
  if (opts.signal?.aborted) return { succeeded: false, logs: "" };
  const body = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: spec.name, namespace },
    spec: {
      backoffLimit: 0, // a failed script is a run failure the step reports, never a silent retry
      ttlSecondsAfterFinished: 600,
      template: {
        spec: {
          restartPolicy: "Never" as const,
          containers: [
            {
              name: "job",
              image: spec.image,
              command: ["/bin/sh", "-ec", spec.script],
              env: (spec.env ?? []).map((e) => ({
                name: e.name,
                ...(e.value !== undefined ? { value: e.value } : {}),
                ...(e.secretKeyRef !== undefined ? { valueFrom: { secretKeyRef: e.secretKeyRef } } : {}),
              })),
              volumeMounts: (spec.pvcMounts ?? []).map((m) => ({ name: m.claimName, mountPath: m.mountPath, ...(m.readOnly !== undefined ? { readOnly: m.readOnly } : {}) })),
            },
          ],
          volumes: (spec.pvcMounts ?? []).map((m) => ({ name: m.claimName, persistentVolumeClaim: { claimName: m.claimName } })),
        },
      },
    },
  };
  try {
    await c.batch.createNamespacedJob({ namespace, body });
  } catch (e) {
    throw upstream(`create Job ${namespace}/${spec.name}`, e);
  }
  const deadline = Date.now() + opts.timeoutMs;
  let succeeded = false;
  let settled = false; // did the Job itself reach succeeded/failed (vs. the poll walking away)?
  for (;;) {
    let status: { succeeded?: number; failed?: number } | undefined;
    try {
      status = (await c.batch.readNamespacedJob({ name: spec.name, namespace })).status;
    } catch (e) {
      throw upstream(`read Job ${namespace}/${spec.name}`, e);
    }
    if ((status?.succeeded ?? 0) > 0) {
      succeeded = true;
      settled = true;
      break;
    }
    if ((status?.failed ?? 0) > 0) {
      settled = true;
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0 || opts.signal?.aborted) break;
    await sleep(Math.min(c.pollMs, remaining), opts.signal);
  }
  const logs = await readJobLog(c, namespace, spec.name);
  if (!settled) {
    // Timeout or abort left the Job RUNNING. The TTL only reaps a finished Job, so without this
    // delete it keeps writing (a relocation dump keeps copying) after the run has already failed
    // — and the next retry's leftover-replace would then delete it mid-write instead of
    // replacing a settled trace. Log first: the foreground delete reaps the pod the log lives in.
    await deleteJobIfPresent(c, namespace, spec.name, opts.signal);
  }
  return { succeeded, logs };
}

/** Delete a leftover Job of this name and wait for it to be gone, so the re-create never 409s.
 *  Foreground propagation reaps the pods with it — a leftover pod would answer the NEW run's log
 *  read with the OLD run's output. The wait is BOUNDED (deleteWaitMs): a Job stuck Terminating —
 *  a held finalizer, an unreachable node — fails this call loud instead of pinning the calling
 *  run in `running` forever; on abort the wait is skipped and the caller reads the signal. */
async function deleteJobIfPresent(c: JobClients, namespace: string, name: string, signal?: AbortSignal): Promise<void> {
  try {
    await c.batch.deleteNamespacedJob({ name, namespace, propagationPolicy: "Foreground" });
  } catch (e) {
    if (isNotFound(e)) return;
    throw upstream(`delete Job ${namespace}/${name}`, e);
  }
  const waitMs = c.deleteWaitMs ?? DELETE_WAIT_MS;
  const deadline = Date.now() + waitMs;
  while (!signal?.aborted) {
    try {
      await c.batch.readNamespacedJob({ name, namespace });
    } catch (e) {
      if (isNotFound(e)) return;
      throw upstream(`read Job ${namespace}/${name}`, e);
    }
    if (Date.now() >= deadline) {
      throw upstream(
        `delete Job ${namespace}/${name}`,
        new Error(`the Job is still present ${waitMs}ms after the delete — stuck Terminating (a held finalizer or an unreachable node); resolve that on the cluster, then retry`),
      );
    }
    await sleep(Math.min(c.pollMs, deadline - Date.now()), signal);
  }
}

/** The collected container log of the Job's pod — empty when no pod ever started (an unschedulable
 *  Job), so a caller always gets a string and its own failure message names the Job. */
async function readJobLog(c: JobClients, namespace: string, jobName: string): Promise<string> {
  try {
    const pods = await c.core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` });
    const pod = pods.items[0]?.metadata?.name;
    if (pod === undefined) return "";
    return await c.core.readNamespacedPodLog({ name: pod, namespace });
  } catch (e) {
    if (isNotFound(e)) return "";
    throw upstream(`read Job log ${namespace}/${jobName}`, e);
  }
}
