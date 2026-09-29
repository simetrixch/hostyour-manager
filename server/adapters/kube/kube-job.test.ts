import { describe, it, expect } from "vitest";
import type { BatchV1Api, CoreV1Api } from "@kubernetes/client-node";
import { runKubeJob, type JobClients } from "./kube-job.ts";
import type { JobSpec } from "./port.ts";

const notFound = (): Error => Object.assign(new Error("jobs.batch \"x\" not found"), { code: 404 });

const spec: JobSpec = { name: "dump-x", image: "dbtools:1", script: "echo hi" };

/** A scripted batch/core pair over one piece of state: does a Job of the name exist, and does it
 *  ever settle. `stuckTerminating` keeps the Job present through every delete — the wedged-node
 *  picture the bounded delete-wait exists for. */
function fakeWorld(opts: { leftover?: boolean; stuckTerminating?: boolean; settles?: boolean } = {}): { c: JobClients; calls: string[] } {
  const calls: string[] = [];
  let exists = opts.leftover ?? false;
  const batch = {
    async deleteNamespacedJob(): Promise<void> {
      calls.push("delete");
      if (!exists) throw notFound();
      if (!opts.stuckTerminating) exists = false;
    },
    async createNamespacedJob(): Promise<void> {
      calls.push("create");
      exists = true;
    },
    async readNamespacedJob(): Promise<{ status: { succeeded?: number } }> {
      calls.push("read");
      if (!exists) throw notFound();
      return { status: opts.settles ? { succeeded: 1 } : {} };
    },
  } as unknown as BatchV1Api;
  const core = {
    async listNamespacedPod(): Promise<{ items: never[] }> {
      return { items: [] };
    },
  } as unknown as CoreV1Api;
  return { c: { batch, core, pollMs: 1, deleteWaitMs: 25 }, calls };
}

/** The part of a created Job a test reads: the pod it asks for. */
interface CreatedJob {
  spec: { template: { spec: { securityContext?: object; containers: { securityContext?: object; env: object[] }[] } } };
}

/** A world whose Job settles FAILED or never settles, with the pods and events the cluster holds, and
 *  the created body kept so a test can read the pod the Job asked for. */
function failingWorld(opts: { pods?: unknown[]; events?: unknown[]; failed?: boolean } = {}): { c: JobClients; created: () => CreatedJob } {
  let body = {} as CreatedJob;
  let exists = false;
  const batch = {
    async deleteNamespacedJob(): Promise<void> {
      if (!exists) throw notFound();
      exists = false;
    },
    async createNamespacedJob(req: { body: CreatedJob }): Promise<void> {
      body = req.body;
      exists = true;
    },
    async readNamespacedJob(): Promise<{ status: { failed?: number } }> {
      if (!exists) throw notFound();
      return { status: opts.failed ? { failed: 1 } : {} };
    },
  } as unknown as BatchV1Api;
  const core = {
    async listNamespacedPod(): Promise<{ items: unknown[] }> {
      return { items: opts.pods ?? [] };
    },
    async readNamespacedPodLog(): Promise<string> {
      return "";
    },
    async listNamespacedEvent(): Promise<{ items: unknown[] }> {
      return { items: opts.events ?? [] };
    },
  } as unknown as CoreV1Api;
  return { c: { batch, core, pollMs: 1, deleteWaitMs: 25 }, created: () => body };
}

describe("runKubeJob under pod security restricted", () => {
  it("asks for a pod `restricted` admits: non-root, RuntimeDefault seccomp, no escalation, no capabilities", async () => {
    // The unit namespaces enforce `restricted`, and the dbtools image runs as root. A pod without
    // these fields is refused there, and the Job then never has a pod to run.
    const { c, created } = failingWorld({ failed: true });
    await runKubeJob(c, "ns", spec, { timeoutMs: 1000 });
    const pod = created().spec.template.spec;
    const container = pod.containers[0]!;
    expect(pod.securityContext).toEqual({ runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534, seccompProfile: { type: "RuntimeDefault" } });
    expect(container.securityContext).toEqual({ allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
    expect(container.env[0]).toEqual({ name: "HOME", value: "/tmp" });
  });

  it("runs as the identity the spec names", async () => {
    const { c, created } = failingWorld({ failed: true });
    await runKubeJob(c, "ns", { ...spec, runAs: { user: 999, group: 999 } }, { timeoutMs: 1000 });
    expect(created().spec.template.spec.securityContext).toMatchObject({ runAsUser: 999, runAsGroup: 999 });
  });

  it("a Job that never got a pod says so, with the refusal its events name", async () => {
    const refusal = 'pods "dump-x-abc" is forbidden: violates PodSecurity "restricted:latest": runAsNonRoot != true';
    const { c } = failingWorld({ events: [{ reason: "Scheduled" }, { reason: "FailedCreate", message: refusal }] });
    const result = await runKubeJob(c, "ns", spec, { timeoutMs: 20 });
    expect(result.succeeded).toBe(false);
    expect(result.ended).toBe(`no pod was created for the Job — ${refusal}`);
  });

  it("a container that was killed names its reason and exit code", async () => {
    const pod = { metadata: { name: "dump-x-abc" }, status: { phase: "Failed", containerStatuses: [{ state: { terminated: { reason: "OOMKilled", exitCode: 137 } } }] } };
    const { c } = failingWorld({ failed: true, pods: [pod] });
    const result = await runKubeJob(c, "ns", spec, { timeoutMs: 1000 });
    expect(result.ended).toBe("the container ended with OOMKilled, exit code 137");
  });

  it("THE INNOCENT NEIGHBOUR: a job that succeeded carries no end reason", async () => {
    const { c } = fakeWorld({ settles: true });
    const result = await runKubeJob(c, "ns", spec, { timeoutMs: 1000 });
    expect(result.ended).toBeUndefined();
  });
});

describe("runKubeJob", () => {
  it("deletes a Job the poll walked away from on TIMEOUT — the Job must not outlive its run", async () => {
    // The Job never settles, so ttlSecondsAfterFinished never starts counting: without the
    // timeout-path delete it keeps writing after the run has already failed.
    const { c, calls } = fakeWorld();
    const result = await runKubeJob(c, "ns", spec, { timeoutMs: 20 });
    expect(result.succeeded).toBe(false);
    expect(calls.indexOf("create")).toBeLessThan(calls.lastIndexOf("delete"));
  });

  it("leaves a Job that SETTLED to its TTL — only an unsettled Job is reaped", async () => {
    const { c, calls } = fakeWorld({ settles: true });
    const result = await runKubeJob(c, "ns", spec, { timeoutMs: 1000 });
    expect(result.succeeded).toBe(true);
    expect(calls.lastIndexOf("delete")).toBeLessThan(calls.indexOf("create"));
  });

  it("bounds the leftover delete-wait — a Job stuck Terminating fails loud instead of pinning the run forever", async () => {
    const { c, calls } = fakeWorld({ leftover: true, stuckTerminating: true });
    await expect(runKubeJob(c, "ns", spec, { timeoutMs: 1000 })).rejects.toThrow(/still present/);
    expect(calls).not.toContain("create"); // the refusal comes before anything new is created
  });

  it("an abort during the delete-wait returns without creating — no 409 against the still-present Job", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { c, calls } = fakeWorld({ leftover: true, stuckTerminating: true });
    const result = await runKubeJob(c, "ns", spec, { timeoutMs: 1000, signal: ctrl.signal });
    expect(result.succeeded).toBe(false);
    expect(calls).not.toContain("create");
  });
});
